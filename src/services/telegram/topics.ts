import bigInt from 'big-integer';
import { Api, getChannel, getClient } from './client';
import { topicsRepo } from '../db/schema';
import { logger, describeError } from '../../utils/logger';
import type { RemoteTopic } from '../../types';

/**
 * Forum-topic operations.
 *
 * Note these live under `Api.messages.*`, not `Api.channels.*`: Telegram moved
 * the forum methods into the messages namespace, and teleproto follows the
 * current layer. Using the old channels.* names fails at runtime.
 */

/** The General topic always has id 1 and cannot be renamed or deleted. */
export const GENERAL_TOPIC_ID = 1;

/** 100 topics per page; 100 pages is far more than any real channel has. */
const MAX_TOPIC_PAGES = 100;

/** Each batch clears a chunk of history; bounds a destructive remote loop. */
const MAX_DELETE_BATCHES = 500;

function randomLong(): ReturnType<typeof bigInt> {
  // Telegram wants a random int64 for de-duplicating create requests.
  const high = Math.floor(Math.random() * 0xffffffff);
  const low = Math.floor(Math.random() * 0xffffffff);
  return bigInt(high).shiftLeft(32).or(bigInt(low));
}

/** Lists every forum topic on the backup channel, paging until exhausted. */
export async function listTopics(): Promise<RemoteTopic[]> {
  const client = await getClient();
  const peer = await getChannel();

  const topics: RemoteTopic[] = [];
  let offsetDate = 0;
  let offsetId = 0;
  let offsetTopic = 0;

  try {
    // Telegram caps a page at 100; loop until a page comes back short. The
    // page cap also bounds the loop, so a cursor that stops advancing (or a
    // server that keeps returning full pages) cannot spin forever.
    for (let page_index = 0; page_index < MAX_TOPIC_PAGES; page_index += 1) {
      const result = await client.invoke(
        new Api.messages.GetForumTopics({
          peer,
          offsetDate,
          offsetId,
          offsetTopic,
          limit: 100,
        }),
      );

      const page = result.topics.filter(
        (topic): topic is Api.ForumTopic => topic instanceof Api.ForumTopic,
      );

      for (const topic of page) {
        topics.push({
          id: topic.id,
          title: topic.title,
          closed: Boolean(topic.closed),
          isGeneral: topic.id === GENERAL_TOPIC_ID,
        });
      }

      if (page.length < 100) {
        break;
      }

      const last = page[page.length - 1];
      if (last.id === offsetTopic) {
        // Cursor did not advance; stop rather than re-request the same page.
        break;
      }
      offsetTopic = last.id;
      offsetId = last.topMessage;
      offsetDate = last.date;
    }
  } catch (error) {
    logger.error('topics', 'Failed to list forum topics', error);
    throw new Error(
      `Could not list topics: ${describeError(error)}. ` +
        'Make sure the channel has Topics enabled (channel settings -> Topics).',
    );
  }

  // Mirror titles locally so FoldersScreen can show names while offline, and so
  // the router can resolve a topic without a network round-trip. Read the
  // existing rows once: folder bindings are ours and must survive a refresh.
  const existing = await topicsRepo.all();
  const boundFolders = new Map(
    existing.map(row => [row.topic_id, row.local_folder]),
  );

  for (const topic of topics) {
    await topicsRepo.upsert({
      topic_id: topic.id,
      title: topic.title,
      local_folder: boundFolders.get(topic.id) ?? null,
    });
  }

  logger.info('topics', `Loaded ${topics.length} topic(s)`);
  return topics;
}

/** Creates a topic and returns its id (the id of its top message). */
export async function createTopic(title: string): Promise<number> {
  const client = await getClient();
  const peer = await getChannel();

  try {
    const updates = await client.invoke(
      new Api.messages.CreateForumTopic({
        peer,
        title,
        randomId: randomLong(),
      }),
    );

    const topicId = extractTopicId(updates);
    if (topicId === null) {
      throw new Error('Telegram did not return the new topic id.');
    }

    await topicsRepo.upsert({ topic_id: topicId, title, local_folder: null });
    logger.info('topics', `Created topic "${title}" (#${topicId})`);
    return topicId;
  } catch (error) {
    logger.error('topics', `Failed to create topic "${title}"`, error);
    throw error;
  }
}

/**
 * A new topic's id is the id of the service message that opens it, so we dig it
 * out of the Updates envelope rather than guessing.
 */
function extractTopicId(updates: Api.TypeUpdates): number | null {
  if (!(updates instanceof Api.Updates)) {
    return null;
  }
  for (const update of updates.updates) {
    if (
      update instanceof Api.UpdateNewChannelMessage ||
      update instanceof Api.UpdateNewMessage
    ) {
      const message = update.message;
      if (
        message instanceof Api.Message ||
        message instanceof Api.MessageService
      ) {
        return message.id;
      }
    }
  }
  return null;
}

export async function renameTopic(
  topicId: number,
  title: string,
): Promise<void> {
  if (topicId === GENERAL_TOPIC_ID) {
    throw new Error('The General topic cannot be renamed.');
  }

  const client = await getClient();
  const peer = await getChannel();

  try {
    await client.invoke(
      new Api.messages.EditForumTopic({ peer, topicId, title }),
    );
    await topicsRepo.setTitle(topicId, title);
    logger.info('topics', `Renamed topic #${topicId} to "${title}"`);
  } catch (error) {
    logger.error('topics', `Failed to rename topic #${topicId}`, error);
    throw error;
  }
}

/**
 * Deletes a topic and everything in it.
 *
 * This is the one place in the app that removes remote data, and it only ever
 * runs from an explicit, confirmed tap in TopicsScreen. The sync engine never
 * calls it. See sync/engine.ts for the one-way-backup guarantee.
 */
export async function deleteTopic(topicId: number): Promise<void> {
  if (topicId === GENERAL_TOPIC_ID) {
    throw new Error('The General topic cannot be deleted.');
  }

  const client = await getClient();
  const peer = await getChannel();

  try {
    // DeleteTopicHistory removes messages in batches; repeat until it reports
    // nothing left, otherwise large topics are only partially cleared. Bounded
    // because this loop deletes remote data — a server that never reports zero
    // must not keep it running.
    for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
      const affected = await client.invoke(
        new Api.messages.DeleteTopicHistory({ peer, topMsgId: topicId }),
      );
      if (affected.offset <= 0) {
        break;
      }
    }

    await topicsRepo.remove(topicId);
    logger.warn('topics', `Deleted topic #${topicId} and its messages`);
  } catch (error) {
    logger.error('topics', `Failed to delete topic #${topicId}`, error);
    throw error;
  }
}

/** Finds a topic by title, creating it when absent. Used by folder binding. */
export async function resolveTopicByTitle(title: string): Promise<number> {
  const topics = await listTopics();
  const match = topics.find(
    topic => topic.title.toLowerCase() === title.toLowerCase(),
  );
  if (match) {
    return match.id;
  }
  return createTopic(title);
}
