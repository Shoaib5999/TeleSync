import { Api, getChannel, getClient } from '../telegram/client';
import { withRetries } from '../telegram/upload';
import { listTopics, createTopic } from '../telegram/topics';
import { configRepo } from '../db/schema';
import {
  INDEX_TOPIC_TITLE,
  SNAPSHOT_FILE_PREFIX,
  SNAPSHOT_FILE_SUFFIX,
} from './snapshot';

/**
 * Channel reads the index needs: walking history, checking which messages
 * still exist, and locating the index topic. Read-only apart from creating
 * the index topic on first use.
 */

const HISTORY_PAGE = 100;
/** 100 per page; bounds a walk at 500k messages. */
const MAX_HISTORY_PAGES = 5000;
const GET_MESSAGES_BATCH = 100;

const INDEX_TOPIC_KEY = 'index_topic_id';

function messagesOf(result: Api.messages.TypeMessages): Api.TypeMessage[] {
  return 'messages' in result ? result.messages : [];
}

/** The forum topic a channel message belongs to; null for General/root. */
export function topicOf(message: Api.Message): number | null {
  const reply = message.replyTo;
  if (reply instanceof Api.MessageReplyHeader && reply.forumTopic) {
    return reply.replyToTopId ?? reply.replyToMsgId ?? null;
  }
  return null;
}

/** The document a message carries, with its stored file name. */
export function documentOf(
  message: Api.Message,
): { name: string; size: number; doc: Api.Document } | null {
  const media = message.media;
  if (
    !(media instanceof Api.MessageMediaDocument) ||
    !(media.document instanceof Api.Document)
  ) {
    return null;
  }
  const doc = media.document;
  let name = '';
  for (const attr of doc.attributes) {
    if (attr instanceof Api.DocumentAttributeFilename) {
      name = attr.fileName;
    }
  }
  return { name, size: Number(doc.size), doc };
}

/**
 * Walks channel history newest-first, only messages with id > minId, handing
 * each page to `onPage`. Every topic is included: channel history is flat.
 */
export async function walkHistory(
  minId: number,
  signal: AbortSignal,
  onPage: (messages: Api.Message[]) => Promise<void> | void,
): Promise<void> {
  const client = await getClient();
  const peer = await getChannel();
  let offsetId = 0;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const raw = messagesOf(
      await withRetries('read channel history', signal, undefined, () =>
        client.invoke(
          new Api.messages.GetHistory({
            peer,
            offsetId,
            offsetDate: 0,
            addOffset: 0,
            limit: HISTORY_PAGE,
            maxId: 0,
            minId,
          }),
        ),
      ),
    );
    const messages = raw.filter(
      (item): item is Api.Message => item instanceof Api.Message,
    );
    if (messages.length > 0) {
      await onPage(messages);
    }
    const ids = raw.map(item => item.id).filter(id => id > 0);
    if (raw.length < HISTORY_PAGE || ids.length === 0) {
      return;
    }
    const next = Math.min(...ids);
    if (next === offsetId || next <= minId + 1) {
      return;
    }
    offsetId = next;
  }
}

/**
 * Which of these message ids still exist in the channel, 100 per request.
 * Deleted ids come back as MessageEmpty.
 */
export async function existingMessageIds(
  ids: number[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Set<number>> {
  const client = await getClient();
  const peer = await getChannel();
  const present = new Set<number>();
  const unique = [...new Set(ids)].filter(id => id > 0);

  for (let i = 0; i < unique.length; i += GET_MESSAGES_BATCH) {
    const batch = unique.slice(i, i + GET_MESSAGES_BATCH);
    const result = await withRetries(
      'check messages exist',
      signal,
      undefined,
      () =>
        client.invoke(
          new Api.channels.GetMessages({
            channel: peer,
            id: batch.map(id => new Api.InputMessageID({ id })),
          }),
        ),
    );
    for (const message of messagesOf(result)) {
      if (message instanceof Api.Message) {
        present.add(message.id);
      }
    }
    onProgress?.(
      Math.min(i + GET_MESSAGES_BATCH, unique.length),
      unique.length,
    );
  }
  return present;
}

/**
 * The index topic's id. Cached in config; on a fresh install it is found by
 * title. `create` makes it when missing (publishing), never when only
 * checking (the restore guard), so checking has no side effects.
 */
export async function findIndexTopicId(
  create: boolean,
): Promise<number | null> {
  const cached = await configRepo.getValue(INDEX_TOPIC_KEY);
  let topics;
  try {
    topics = await listTopics();
  } catch (error) {
    // A channel without Topics is supported for backups (files go to the
    // root), so the index lives at the root too.
    if (isForumMissing(error)) {
      return null;
    }
    throw error;
  }
  if (cached) {
    const id = Number(cached);
    if (topics.some(topic => topic.id === id)) {
      return id;
    }
  }
  const match = topics.find(
    topic => topic.title.toLowerCase() === INDEX_TOPIC_TITLE.toLowerCase(),
  );
  if (match) {
    await configRepo.setValue(INDEX_TOPIC_KEY, String(match.id));
    return match.id;
  }
  if (!create) {
    return null;
  }
  const id = await createTopic(INDEX_TOPIC_TITLE);
  await configRepo.setValue(INDEX_TOPIC_KEY, String(id));
  return id;
}

/** True when the channel simply has Topics turned off. */
export function isForumMissing(error: unknown): boolean {
  return /FORUM_MISSING|not a forum|Topics enabled/i.test(
    String(error instanceof Error ? error.message : error),
  );
}

/**
 * Newest-first snapshot candidates found by Telegram's own search: the
 * caption starts "TeleSync index". Used for channels without Topics, where
 * the snapshot sits at the root among the backed-up files.
 */
export async function searchSnapshotMessages(
  signal: AbortSignal,
): Promise<Api.Message[]> {
  const client = await getClient();
  const peer = await getChannel();
  const raw = messagesOf(
    await withRetries('search for index snapshot', signal, undefined, () =>
      client.invoke(
        new Api.messages.Search({
          peer,
          q: 'TeleSync index',
          filter: new Api.InputMessagesFilterDocument(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 20,
          maxId: 0,
          minId: 0,
        }),
      ),
    ),
  );
  return raw.filter((item): item is Api.Message => item instanceof Api.Message);
}

/** Newest-first messages of one topic, for finding the latest snapshot. */
export async function topicMessages(
  topicId: number,
  limit: number,
  signal: AbortSignal,
): Promise<Api.Message[]> {
  const client = await getClient();
  const peer = await getChannel();
  const raw = messagesOf(
    await withRetries('read index topic', signal, undefined, () =>
      client.invoke(
        new Api.messages.GetReplies({
          peer,
          msgId: topicId,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          limit,
          maxId: 0,
          minId: 0,
        }),
      ),
    ),
  );
  return raw.filter((item): item is Api.Message => item instanceof Api.Message);
}

/** Names this app gives its snapshot documents. */
export function isSnapshotName(name: string): boolean {
  return (
    name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith(SNAPSHOT_FILE_SUFFIX)
  );
}

/**
 * The newest snapshot message: from the index topic, or found by search in a
 * channel without Topics. null when the channel has never had one.
 */
export async function latestSnapshotMessage(
  signal: AbortSignal,
): Promise<{ topicId: number | null; message: Api.Message } | null> {
  const topicId = await findIndexTopicId(false);
  const messages =
    topicId !== null
      ? await topicMessages(topicId, 30, signal)
      : await searchSnapshotMessages(signal);
  for (const message of messages) {
    const doc = documentOf(message);
    if (doc && isSnapshotName(doc.name)) {
      return { topicId, message };
    }
  }
  return null;
}
