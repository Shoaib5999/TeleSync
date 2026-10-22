/**
 * Index recovery logic: caption tags, snapshot shaping, and merging.
 *
 * These are the pure pieces a restore depends on; the network and SQLite
 * halves only move what these functions produce.
 */
import {
  decodePlainTag,
  encodeSealedTag,
  encodeTag,
  parseTag,
  stripTag,
} from '../tag';
import {
  buildSnapshotParts,
  legacyKey,
  mergeRecovered,
  parsePrivateBody,
  parseSnapshot,
  rowToRecovered,
  type RecoveredRow,
} from '../snapshot';
import {
  DEFAULT_CONFIG,
  type FileRecord,
  type TopicRecord,
} from '../../../types';

const HASH = 'a'.repeat(64);

function record(overrides: Partial<FileRecord>): FileRecord {
  return {
    id: 1,
    local_path: '/storage/emulated/0/DCIM/Camera/IMG_1.jpg',
    size: 2048,
    mtime: 1_700_000_000,
    message_id: 10,
    topic_id: 5,
    uploaded_at: 1_700_000_100,
    status: 'uploaded',
    encrypted: false,
    file_name: 'IMG_1.jpg',
    content_hash: HASH,
    ...overrides,
  };
}

describe('caption tag', () => {
  it('round-trips every field', () => {
    const fields = {
      localPath: '/storage/emulated/0/DCIM/Camera/IMG_1.jpg',
      size: 123456,
      mtime: 1_700_000_000,
      contentHash: HASH,
    };
    expect(decodePlainTag(encodeTag(fields))).toEqual(fields);
  });

  it('keeps a path containing the separator intact', () => {
    const fields = {
      localPath: '/storage/emulated/0/odd|name|here.jpg',
      size: 1,
      mtime: 2,
      contentHash: null,
    };
    expect(decodePlainTag(encodeTag(fields))).toEqual(fields);
  });

  it('keeps unicode paths', () => {
    const fields = {
      localPath: '/storage/emulated/0/Pictures/छुट्टी/海滩 🏖.jpg',
      size: 9,
      mtime: 9,
      contentHash: null,
    };
    expect(decodePlainTag(encodeTag(fields))).toEqual(fields);
  });

  it('drops a malformed hash rather than storing garbage', () => {
    const tag = encodeTag({
      localPath: '/a/b.jpg',
      size: 1,
      mtime: 1,
      contentHash: 'not-a-hash',
    });
    expect(decodePlainTag(tag)?.contentHash).toBeNull();
  });

  it('rejects things that only look like tags', () => {
    expect(parseTag('')).toBeNull();
    expect(parseTag('holiday photos')).toBeNull();
    expect(parseTag('TS1|abc|1||/a.jpg')).toBeNull();
    expect(parseTag('TS1|1|1||relative/path.jpg')).toBeNull();
    expect(parseTag('TS1|0|1||/a.jpg')).toBeNull();
    expect(parseTag('TS1|1|1|' + 'g'.repeat(64) + '|/a.jpg')).toBeNull();
    expect(parseTag('TS1E|***')).toBeNull();
    expect(parseTag('TeleSync index · 12 files')).toBeNull();
  });

  it('round-trips a sealed payload through base64url', () => {
    const payload = Buffer.from([
      0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63,
    ]);
    const parsed = parseTag(encodeSealedTag(payload));
    expect(parsed?.kind).toBe('sealed');
    expect(parsed && parsed.kind === 'sealed' && parsed.payload).toEqual(
      payload,
    );
  });

  it('reads the tag from the first line and strips it for display', () => {
    const tag = encodeTag({
      localPath: '/a/b.jpg',
      size: 1,
      mtime: 1,
      contentHash: null,
    });
    const caption = `${tag}\nmy note`;
    expect(parseTag(caption)?.kind).toBe('plain');
    expect(stripTag(caption)).toBe('my note');
    expect(stripTag(tag)).toBe('');
    expect(stripTag('just a caption')).toBe('just a caption');
  });
});

describe('snapshot', () => {
  const topics: TopicRecord[] = [
    {
      topic_id: 5,
      title: 'Camera',
      local_folder: '/storage/emulated/0/DCIM/Camera',
      mirror_deletes: true,
      encrypt: false,
    },
    {
      topic_id: 6,
      title: 'Private',
      local_folder: '/storage/emulated/0/Secret',
      mirror_deletes: false,
      encrypt: true,
    },
  ];

  it('keeps encrypted rows and folders out of the plain part', () => {
    const { body, privateBody } = buildSnapshotParts(
      [
        record({ id: 1, message_id: 10 }),
        record({
          id: 2,
          local_path: '/storage/emulated/0/Secret/passport.pdf',
          message_id: 42,
          topic_id: 6,
          encrypted: true,
          file_name: 'passport.pdf',
        }),
      ],
      topics,
      { ...DEFAULT_CONFIG, apiId: 99, apiHash: 'secret', channelId: '-100' },
      1_800_000_000,
    );

    const plain = JSON.stringify(body);
    expect(plain).not.toContain('passport');
    expect(plain).not.toContain('/Secret');
    expect(plain).not.toContain('secret');
    expect(body.files).toHaveLength(1);
    expect(body.maxMessageId).toBe(42);
    expect(body.topics.find(t => t.id === 6)?.folder).toBeNull();
    expect(privateBody?.files[0][0]).toBe(
      '/storage/emulated/0/Secret/passport.pdf',
    );
    expect(privateBody?.topics).toEqual([
      { id: 6, folder: '/storage/emulated/0/Secret' },
    ]);
    // Credentials and the channel never travel.
    expect(body.settings).not.toHaveProperty('apiId');
    expect(body.settings).not.toHaveProperty('channelId');
  });

  it('has no private part when nothing is encrypted', () => {
    const { privateBody } = buildSnapshotParts(
      [record({})],
      [topics[0]],
      DEFAULT_CONFIG,
      1,
    );
    expect(privateBody).toBeNull();
  });

  it('skips failed and pending rows', () => {
    const { body } = buildSnapshotParts(
      [
        record({ status: 'failed', message_id: 0 }),
        record({ id: 2, local_path: '/x/y.jpg' }),
      ],
      [],
      DEFAULT_CONFIG,
      1,
    );
    expect(body.files.map(row => row[0])).toEqual(['/x/y.jpg']);
  });

  it('round-trips through JSON and maps back to recoverable rows', () => {
    const { body, privateBody } = buildSnapshotParts(
      [
        record({ content_hash: '' }),
        record({
          id: 2,
          local_path: '/s/p.pdf',
          encrypted: true,
          message_id: 11,
        }),
      ],
      topics,
      DEFAULT_CONFIG,
      5,
    );
    const parsed = parseSnapshot(JSON.stringify({ ...body, private: 'abc' }));
    expect(parsed.files).toHaveLength(1);
    expect(parsed.private).toBe('abc');
    const restored = rowToRecovered(parsed.files[0], false);
    expect(restored).toMatchObject({
      localPath: '/storage/emulated/0/DCIM/Camera/IMG_1.jpg',
      messageId: 10,
      topicId: 5,
      encrypted: false,
      // '' means "unknowable" locally and travels as null.
      contentHash: null,
    });
    const priv = parsePrivateBody(JSON.stringify(privateBody));
    expect(rowToRecovered(priv.files[0], true).encrypted).toBe(true);
  });

  it('refuses a snapshot from a newer app version and junk input', () => {
    expect(() => parseSnapshot(JSON.stringify({ v: 99 }))).toThrow(
      /newer version/,
    );
    expect(() => parseSnapshot('null')).toThrow();
    expect(
      parseSnapshot(JSON.stringify({ v: 1, files: [['nope'], 3] })).files,
    ).toEqual([]);
  });
});

describe('merge', () => {
  const base: RecoveredRow = {
    localPath: '/a.jpg',
    size: 1,
    mtime: 1,
    messageId: 10,
    topicId: null,
    encrypted: false,
    fileName: 'a.jpg',
    contentHash: null,
    uploadedAt: 1,
  };

  it('keeps one row per path, the newest message winning', () => {
    const merged = mergeRecovered(
      [base, { ...base, localPath: '/b.jpg', messageId: 3 }],
      [
        { ...base, messageId: 20, mtime: 2 },
        { ...base, messageId: 5 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find(row => row.localPath === '/a.jpg')).toMatchObject({
      messageId: 20,
      mtime: 2,
    });
  });
});

describe('legacy adopt key', () => {
  it('maps an encrypted upload back to the original name and size', () => {
    expect(legacyKey('IMG_1.jpg', 1000)).toEqual({
      key: 'IMG_1.jpg|1000',
      encrypted: false,
    });
    expect(legacyKey('IMG_1.jpg.tgbk', 1049)).toEqual({
      key: 'IMG_1.jpg|1000',
      encrypted: true,
    });
  });
});
