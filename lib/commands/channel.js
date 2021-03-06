/*jshint esversion: 6 */
const Channel = module.exports;

const Util = require("../common-util");
const nThen = require("nthen");
const Core = require("./core");
const Metadata = require("./metadata");

Channel.clearOwnedChannel = function (Env, safeKey, channelId, cb, Server) {
    if (typeof(channelId) !== 'string' || channelId.length !== 32) {
        return cb('INVALID_ARGUMENTS');
    }
    var unsafeKey = Util.unescapeKeyCharacters(safeKey);

    Metadata.getMetadata(Env, channelId, function (err, metadata) {
        if (err) { return void cb(err); }
        if (!Core.hasOwners(metadata)) { return void cb('E_NO_OWNERS'); }
        // Confirm that the channel is owned by the user in question
        if (!Core.isOwner(metadata, unsafeKey)) {
            return void cb('INSUFFICIENT_PERMISSIONS');
        }
        return void Env.msgStore.clearChannel(channelId, function (e) {
            if (e) { return void cb(e); }
            cb();

            const channel_cache = Env.channel_cache;

            const clear = function () {
                // delete the channel cache because it will have been invalidated
                delete channel_cache[channelId];
            };

            nThen(function (w) {
                Server.getChannelUserList(channelId).forEach(function (userId) {
                    Server.send(userId, [
                        0,
                        Env.historyKeeper.id,
                        'MSG',
                        userId,
                        JSON.stringify({
                            error: 'ECLEARED',
                            channel: channelId
                        })
                    ], w());
                });
            }).nThen(function () {
                clear();
            }).orTimeout(function () {
                Env.Log.warn("ON_CHANNEL_CLEARED_TIMEOUT", channelId);
                clear();
            }, 30000);
        });
    });
};

Channel.removeOwnedChannel = function (Env, safeKey, channelId, cb, Server) {
    if (typeof(channelId) !== 'string' || !Core.isValidId(channelId)) {
        return cb('INVALID_ARGUMENTS');
    }
    var unsafeKey = Util.unescapeKeyCharacters(safeKey);

    if (Env.blobStore.isFileId(channelId)) {
        var blobId = channelId;

        return void nThen(function (w) {
            // check if you have permissions
            Env.blobStore.isOwnedBy(safeKey, blobId, w(function (err, owned) {
                if (err || !owned) {
                    w.abort();
                    return void cb("INSUFFICIENT_PERMISSIONS");
                }
            }));
        }).nThen(function (w) {
            // remove the blob
            return void Env.blobStore.archive.blob(blobId, w(function (err) {
                Env.Log.info('ARCHIVAL_OWNED_FILE_BY_OWNER_RPC', {
                    safeKey: safeKey,
                    blobId: blobId,
                    status: err? String(err): 'SUCCESS',
                });
                if (err) {
                    w.abort();
                    return void cb(err);
                }
            }));
        }).nThen(function () {
            // archive the proof
            return void Env.blobStore.archive.proof(safeKey, blobId, function (err) {
                Env.Log.info("ARCHIVAL_PROOF_REMOVAL_BY_OWNER_RPC", {
                    safeKey: safeKey,
                    blobId: blobId,
                    status: err? String(err): 'SUCCESS',
                });
                if (err) {
                    return void cb("E_PROOF_REMOVAL");
                }
                cb(void 0, 'OK');
            });
        });
    }

    Metadata.getMetadata(Env, channelId, function (err, metadata) {
        if (err) { return void cb(err); }
        if (!Core.hasOwners(metadata)) { return void cb('E_NO_OWNERS'); }
        if (!Core.isOwner(metadata, unsafeKey)) {
            return void cb('INSUFFICIENT_PERMISSIONS');
        }
        // temporarily archive the file
        return void Env.msgStore.archiveChannel(channelId, function (e) {
            Env.Log.info('ARCHIVAL_CHANNEL_BY_OWNER_RPC', {
                unsafeKey: unsafeKey,
                channelId: channelId,
                status: e? String(e): 'SUCCESS',
            });
            if (e) {
                return void cb(e);
            }
            cb(void 0, 'OK');

            const channel_cache = Env.channel_cache;
            const metadata_cache = Env.metadata_cache;

            const clear = function () {
                delete channel_cache[channelId];
                Server.clearChannel(channelId);
                delete metadata_cache[channelId];
            };

            // an owner of a channel deleted it
            nThen(function (w) {
                // close the channel in the store
                Env.msgStore.closeChannel(channelId, w());
            }).nThen(function (w) {
                // Server.channelBroadcast would be better
                // but we can't trust it to track even one callback,
                // let alone many in parallel.
                // so we simulate it on this side to avoid race conditions
                Server.getChannelUserList(channelId).forEach(function (userId) {
                    Server.send(userId, [
                        0,
                        Env.historyKeeper.id,
                        "MSG",
                        userId,
                        JSON.stringify({
                            error: 'EDELETED',
                            channel: channelId,
                        })
                    ], w());
                });
            }).nThen(function () {
                // clear the channel's data from memory
                // once you've sent everyone a notice that the channel has been deleted
                clear();
            }).orTimeout(function () {
                Env.Log.warn('ON_CHANNEL_DELETED_TIMEOUT', channelId);
                clear();
            }, 30000);
        });
    });
};

Channel.trimHistory = function (Env, safeKey, data, cb) {
    if (!(data && typeof(data.channel) === 'string' && typeof(data.hash) === 'string' && data.hash.length === 64)) {
        return void cb('INVALID_ARGS');
    }

    var channelId = data.channel;
    var unsafeKey = Util.unescapeKeyCharacters(safeKey);
    var hash = data.hash;

    nThen(function (w) {
        Metadata.getMetadata(Env, channelId, w(function (err, metadata) {
            if (err) { return void cb(err); }
            if (!Core.hasOwners(metadata)) {
                w.abort();
                return void cb('E_NO_OWNERS');
            }
            if (!Core.isOwner(metadata, unsafeKey)) {
                w.abort();
                return void cb("INSUFFICIENT_PERMISSIONS");
            }
            // else fall through to the next block
        }));
    }).nThen(function () {
        Env.msgStore.trimChannel(channelId, hash, function (err) {
            if (err) { return void cb(err); }
            // clear historyKeeper's cache for this channel
            Env.historyKeeper.channelClose(channelId);
            cb(void 0, 'OK');
            delete Env.channel_cache[channelId];
            delete Env.metadata_cache[channelId];
        });
    });
};

var ARRAY_LINE = /^\[/;

/*  Files can contain metadata but not content
    call back with true if the channel log has no content other than metadata
    otherwise false
*/
Channel.isNewChannel = function (Env, channel, cb) {
    if (!Core.isValidId(channel)) { return void cb('INVALID_CHAN'); }
    if (channel.length !== 32) { return void cb('INVALID_CHAN'); }

    var done = false;
    Env.msgStore.getMessages(channel, function (msg) {
        if (done) { return; }
        try {
            if (typeof(msg) === 'string' && ARRAY_LINE.test(msg)) {
                done = true;
                return void cb(void 0, false);
            }
        } catch (e) {
            Env.WARN('invalid message read from store', e);
        }
    }, function () {
        if (done) { return; }
        // no more messages...
        cb(void 0, true);
    });
};

/*  writePrivateMessage
    allows users to anonymously send a message to the channel
    prevents their netflux-id from being stored in history
    and from being broadcast to anyone that might currently be in the channel

    Otherwise behaves the same as sending to a channel
*/
Channel.writePrivateMessage = function (Env, args, cb, Server) {
    var channelId = args[0];
    var msg = args[1];

    // don't bother handling empty messages
    if (!msg) { return void cb("INVALID_MESSAGE"); }

    // don't support anything except regular channels
    if (!Core.isValidId(channelId) || channelId.length !== 32) {
        return void cb("INVALID_CHAN");
    }

    // We expect a modern netflux-websocket-server instance
    // if this API isn't here everything will fall apart anyway
    if (!(Server && typeof(Server.send) === 'function')) {
        return void cb("NOT_IMPLEMENTED");
    }

    // historyKeeper expects something with an 'id' attribute
    // it will fail unless you provide it, but it doesn't need anything else
    var channelStruct = {
        id: channelId,
    };

    // construct a message to store and broadcast
    var fullMessage = [
        0, // idk
        null, // normally the netflux id, null isn't rejected, and it distinguishes messages written in this way
        "MSG", // indicate that this is a MSG
        channelId, // channel id
        msg // the actual message content. Generally a string
    ];

    // XXX RESTRICT respect allow lists

    // historyKeeper already knows how to handle metadata and message validation, so we just pass it off here
    // if the message isn't valid it won't be stored.
    Env.historyKeeper.channelMessage(Server, channelStruct, fullMessage);

    Server.getChannelUserList(channelId).forEach(function (userId) {
        Server.send(userId, fullMessage);
    });

    cb();
};

