// Large attachments sit in Aliyun OSS until the phone sends the message.
// Credentials stay in ~/.cursor-remote-lite/oss.json and never go into the repo.
import fs from 'node:fs';
import path from 'node:path';
import OSS from 'ali-oss';
import { DATA_DIR } from './auth.mjs';

const FILE = path.join(DATA_DIR, 'oss.json');

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!cfg.accessKeyId || !cfg.accessKeySecret || !cfg.bucket) return null;
    return cfg;
  } catch {
    return null;
  }
}

let client = null;
function bucket() {
  const cfg = readConfig();
  if (!cfg) throw new Error('还没有配置 OSS');
  if (!client) {
    client = new OSS({
      region: cfg.region || 'oss-cn-beijing',
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      secure: true,
      timeout: 10 * 60 * 1000,
    });
    client._prefix = String(cfg.prefix || 'cursor-remote').replace(/^\/+|\/+$/g, '');
  }
  return client;
}

const objectKey = key => {
  const c = bucket();
  return `${c._prefix}/${String(key).replace(/^\/+/, '')}`;
};

export async function ossPut(key, file) {
  const c = bucket();
  const object = objectKey(key);
  await c.put(object, file);
  return object;
}

export async function ossGet(object, file) {
  await bucket().get(object, file);
}

export async function ossDel(object) {
  await bucket().delete(object).catch(e => {
    if (e?.status !== 404 && e?.code !== 'NoSuchKey') throw e;
  });
}
