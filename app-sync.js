let { Buffer } = require('buffer');
let { join } = require('path');
let express = require('express');
let uuid = require('uuid');
let AdmZip = require('adm-zip');
let { validateUser } = require('./util/validate-user');
let errorMiddleware = require('./util/error-middleware');
let config = require('./load-config');
let { getAccountDb } = require('./account-db');

let fullSync = require('./sync-full');

let actual = require('@actual-app/api');
let SyncPb = actual.internal.SyncProtoBuf;

const app = express();
app.use(errorMiddleware);

async function init() {
  let fileDir = join(process.env.ACTUAL_USER_FILES || config.userFiles);

  console.log('Initializing Actual with user file dir:', fileDir);

  await actual.init({
    config: {
      dataDir: fileDir
    }
  });
}

// This is a version representing the internal format of sync
// messages. When this changes, all sync files need to be reset. We
// will check this version when syncing and notify the user if they
// need to reset.
const SYNC_FORMAT_VERSION = 2;

app.post('/sync', async (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }

  let requestPb;
  try {
    requestPb = SyncPb.SyncRequest.deserializeBinary(req.body);
  } catch (e) {
    res.status(500);
    res.send({ status: 'error', reason: 'internal-error' });
    return;
  }

  let accountDb = getAccountDb();
  let file_id = requestPb.getFileid() || null;
  let group_id = requestPb.getGroupid() || null;
  let key_id = requestPb.getKeyid() || null;
  let since = requestPb.getSince() || null;
  let messages = requestPb.getMessagesList();

  if (!since) {
    throw new Error('`since` is required');
  }

  let currentFiles = accountDb.all(
    'SELECT group_id, encrypt_keyid, encrypt_meta, sync_version FROM files WHERE id = ?',
    [file_id]
  );

  if (currentFiles.length === 0) {
    res.status(400);
    res.send('file-not-found');
    return;
  }

  let currentFile = currentFiles[0];

  if (
    currentFile.sync_version == null ||
    currentFile.sync_version < SYNC_FORMAT_VERSION
  ) {
    res.status(400);
    res.send('file-old-version');
    return;
  }

  // When resetting sync state, something went wrong. There is no
  // group id and it's awaiting a file to be uploaded.
  if (currentFile.group_id == null) {
    res.status(400);
    res.send('file-needs-upload');
    return;
  }

  // Check to make sure the uploaded file is valid and has been
  // encrypted with the same key it is registered with (this might
  // be wrong if there was an error during the key creation
  // process)
  let uploadedKeyId = currentFile.encrypt_meta
    ? JSON.parse(currentFile.encrypt_meta).keyId
    : null;
  if (uploadedKeyId !== currentFile.encrypt_keyid) {
    res.status(400);
    res.send('file-key-mismatch');
    return;
  }

  // The changes being synced are part of an old group, which
  // means the file has been reset. User needs to re-download.
  if (group_id !== currentFile.group_id) {
    res.status(400);
    res.send('file-has-reset');
    return;
  }

  // The data is encrypted with a different key which is
  // unacceptable. We can't accept these changes. Reject them and
  // tell the user that they need to generate the correct key
  // (which necessitates a sync reset so they need to re-download).
  if (key_id !== currentFile.encrypt_keyid) {
    res.status(400);
    res.send('file-has-new-key');
    return false;
  }

  // TODO: We also provide a "simple" sync method which currently isn't
  // used. This method just stores the messages locally and doesn't
  // load the whole app at all. If we want to support end-to-end
  // encryption, this method is required because we can't read the
  // messages. Using it looks like this:
  //
  // let simpleSync = require('./sync-simple');
  // let {trie, newMessages } = simpleSync.sync(messages, since, file_id);

  let { trie, newMessages } = await fullSync.sync(messages, since, file_id);

  // encode it back...
  let responsePb = new SyncPb.SyncResponse();
  responsePb.setMerkle(JSON.stringify(trie));

  for (let i = 0; i < newMessages.length; i++) {
    let msg = newMessages[i];
    let envelopePb = new SyncPb.MessageEnvelope();
    envelopePb.setTimestamp(msg.timestamp);
    envelopePb.setIsencrypted(msg.is_encrypted === 1);
    envelopePb.setContent(msg.content);
    responsePb.addMessages(envelopePb);
  }

  res.set('Content-Type', 'application/actual-sync');
  res.send(Buffer.from(responsePb.serializeBinary()));
});

app.post('/user-get-key', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }

  let accountDb = getAccountDb();
  let { fileId } = req.body;

  let rows = accountDb.all(
    'SELECT encrypt_salt, encrypt_keyid, encrypt_test FROM files WHERE id = ?',
    [fileId]
  );
  if (rows.length === 0) {
    res.status(400).send('file-not-found');
    return;
  }
  let { encrypt_salt, encrypt_keyid, encrypt_test } = rows[0];

  res.send(
    JSON.stringify({
      status: 'ok',
      data: { id: encrypt_keyid, salt: encrypt_salt, test: encrypt_test }
    })
  );
});

app.post('/user-create-key', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let { fileId, keyId, keySalt, testContent } = req.body;

  accountDb.mutate(
    'UPDATE files SET encrypt_salt = ?, encrypt_keyid = ?, encrypt_test = ? WHERE id = ?',
    [keySalt, keyId, testContent, fileId]
  );

  res.send(JSON.stringify({ status: 'ok' }));
});

app.post('/reset-user-file', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let { fileId } = req.body;

  let files = accountDb.all('SELECT group_id FROM files WHERE id = ?', [
    fileId
  ]);
  if (files.length === 0) {
    res.status(400).send('User or file not found');
    return;
  }
  let { group_id } = files[0];

  accountDb.mutate('UPDATE files SET group_id = NULL WHERE id = ?', [fileId]);

  if (group_id) {
    // TODO: Instead of doing this, just delete the db file named
    // after the group
    // db.mutate('DELETE FROM messages_binary WHERE group_id = ?', [group_id]);
    // db.mutate('DELETE FROM messages_merkles WHERE group_id = ?', [group_id]);
  }

  res.send(JSON.stringify({ status: 'ok' }));
});

app.post('/upload-user-file', async (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }

  let accountDb = getAccountDb();
  let name = decodeURIComponent(req.headers['x-actual-name']);
  let fileId = req.headers['x-actual-file-id'];
  let groupId = req.headers['x-actual-group-id'] || null;
  let encryptMeta = req.headers['x-actual-encrypt-meta'] || null;
  let syncFormatVersion = req.headers['x-actual-format'] || null;

  let keyId = encryptMeta ? JSON.parse(encryptMeta).keyId : null;

  if (!fileId) {
    throw new Error('fileId is required');
  }

  let currentFiles = accountDb.all(
    'SELECT group_id, encrypt_keyid, encrypt_meta FROM files WHERE id = ?',
    [fileId]
  );
  if (currentFiles.length) {
    let currentFile = currentFiles[0];

    // The uploading file is part of an old group, so reject
    // it. All of its internal sync state is invalid because its
    // old. The sync state has been reset, so user needs to
    // either reset again or download from the current group.
    if (groupId !== currentFile.group_id) {
      res.status(400);
      res.send('file-has-reset');
      return;
    }

    // The key that the file is encrypted with is different than
    // the current registered key. All data must always be
    // encrypted with the registered key for consistency. Key
    // changes always necessitate a sync reset, which means this
    // upload is trying to overwrite another reset. That might
    // be be fine, but since we definitely cannot accept a file
    // encrypted with the wrong key, we bail and suggest the
    // user download the latest file.
    if (keyId !== currentFile.encrypt_keyid) {
      res.status(400);
      res.send('file-has-new-key');
      return;
    }
  }

  // TODO: If we want to support end-to-end encryption, we'd write the
  // raw file down because it's an encrypted blob. This isn't
  // supported yet in the self-hosted version because it's unclear if
  // it's still needed, given that you own your server
  //
  // await fs.writeFile(join(config.userFiles, `${fileId}.blob`), req.body);

  let zip = new AdmZip(req.body);

  try {
    zip.extractAllTo(join(config.userFiles, fileId), true);
  } catch (err) {
    console.log('Error writing file', err);
    res.send(JSON.stringify({ status: 'error' }));
    return;
  }

  let rows = accountDb.all('SELECT id FROM files WHERE id = ?', [fileId]);
  if (rows.length === 0) {
    // it's new
    groupId = uuid.v4();
    accountDb.mutate(
      'INSERT INTO files (id, group_id, sync_version, name, encrypt_meta) VALUES (?, ?, ?, ?, ?)',
      [fileId, groupId, syncFormatVersion, name, encryptMeta]
    );
    res.send(JSON.stringify({ status: 'ok', groupId }));
  } else {
    if (!groupId) {
      // sync state was reset, create new group
      groupId = uuid.v4();
      accountDb.mutate('UPDATE files SET group_id = ? WHERE id = ?', [
        groupId,
        fileId
      ]);
    }

    // Regardless, update some properties
    accountDb.mutate(
      'UPDATE files SET sync_version = ?, encrypt_meta = ?, name = ? WHERE id = ?',
      [syncFormatVersion, encryptMeta, name, fileId]
    );
    res.send(JSON.stringify({ status: 'ok', groupId }));
  }
});

app.get('/download-user-file', async (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let fileId = req.headers['x-actual-file-id'];

  // Do some authentication
  let rows = accountDb.all(
    'SELECT id FROM files WHERE id = ? AND deleted = FALSE',
    [fileId]
  );
  if (rows.length === 0) {
    res.status(400).send('User or file not found');
    return;
  }

  let zip = new AdmZip();
  try {
    zip.addLocalFolder(join(config.userFiles, fileId), '/');
  } catch (e) {
    res.status(500).send('Error reading files');
    return;
  }
  let buffer = zip.toBuffer();

  res.setHeader('Content-Disposition', `attachment;filename=${fileId}`);
  res.send(buffer);
});

app.post('/update-user-filename', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let { fileId, name } = req.body;

  // Do some authentication
  let rows = accountDb.all(
    'SELECT id FROM files WHERE id = ? AND deleted = FALSE',
    [fileId]
  );
  if (rows.length === 0) {
    res.status(500).send('User or file not found');
    return;
  }

  accountDb.mutate('UPDATE files SET name = ? WHERE id = ?', [name, fileId]);

  res.send(JSON.stringify({ status: 'ok' }));
});

app.get('/list-user-files', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }

  let accountDb = getAccountDb();
  let rows = accountDb.all('SELECT * FROM files');

  res.send(
    JSON.stringify({
      status: 'ok',
      data: rows.map(row => ({
        deleted: row.deleted,
        fileId: row.id,
        groupId: row.group_id,
        name: row.name,
        encryptKeyId: row.encrypt_keyid
      }))
    })
  );
});

app.get('/get-user-file-info', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let fileId = req.headers['x-actual-file-id'];

  let rows = accountDb.all(
    'SELECT * FROM files WHERE id = ? AND deleted = FALSE',
    [fileId]
  );
  if (rows.length === 0) {
    res.send(JSON.stringify({ status: 'error' }));
    return;
  }
  let row = rows[0];

  res.send(
    JSON.stringify({
      status: 'ok',
      data: {
        deleted: row.deleted,
        fileId: row.id,
        groupId: row.group_id,
        name: row.name,
        encryptMeta: row.encrypt_meta ? JSON.parse(row.encrypt_meta) : null
      }
    })
  );
});

app.post('/delete-user-file', (req, res) => {
  let user = validateUser(req, res);
  if (!user) {
    return;
  }
  let accountDb = getAccountDb();
  let { fileId } = req.body;

  accountDb.mutate('UPDATE files SET deleted = TRUE WHERE id = ?', [fileId]);
  res.send(JSON.stringify({ status: 'ok' }));
});

module.exports.handlers = app;
module.exports.init = init;
