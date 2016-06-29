/**
 *      lgtv2 - Simple Node.js module to remote control LG WebOS smart TVs
 *
 *      MIT (c) 2015 Sebastian Raff <hq@ccu.io> (https://github.com/hobbyquaker)
 *      this is a fork of https://github.com/msloth/lgtv.js, heavily modified and rewritten to suite my needs.
 *
 */

var fs = require('fs'); // for storing client key
var WebSocketClient = require('websocket').client; // for communication with TV
var EventEmitter = require('events').EventEmitter;
var util =  require('util');

var LGTV = function (config) {
    if (!(this instanceof LGTV)) return new LGTV(config);
    var that = this;

    config = config || {};
    config.url = config.url || 'ws://lgwebostv:3000';
    config.timeout = config.timeout || 15000;
    config.reconnect = typeof config.reconnect === 'undefined' ? 5000 : config.reconnect;
    if (config.clientKey === undefined) {
        config.keyFile = (config.keyFile ? config.keyFile : './lgtv-') + config.url.replace(/[a-z]+:\/\/([0-9a-zA-Z-_.]+):[0-9]+/, '$1');
        try {
            that.clientKey = fs.readFileSync(config.keyFile).toString();
        } catch (e) {
            //console.error(config.keyFile, e);
        }    
    } else {
        that.clientKey = config.clientKey;
    }

    that.saveKey = config.saveKey || function (key, cb) {
        //console.log('saveKey', config.address, key);
        that.clientKey = key;
        fs.writeFile(config.keyFile, key, cb);
    };
    
    var client = new WebSocketClient();
    var connection = {};
    var isPaired = false;
    var autoReconnect = config.reconnect;

    var callbacks = {};
    var cidCount = 0;
    var cidPrefix = ('0000000' + (Math.floor(Math.random() * 0xFFFFFFFF).toString(16))).slice(-8);

    function getCid() {
        return cidPrefix + ('000' + (cidCount++).toString(16)).slice(-4);
    }

    var pairing = require('./pairing.json');

    client.on('connectFailed', function (error) {
        //console.log('connect failed', error);
        that.emit('error', error);

        if (config.reconnect) {
            setTimeout(function () {
                if (autoReconnect) that.connect(config.url);
            }, config.reconnect);
        }
    });

    client.on('connect', function (conn) {
        //console.log('client connect', connection);
        connection = conn;

        connection.on('error', function (error) {
            //console.log('connection error', error);
            that.emit('error', error);
        });

        connection.on('close', function (e) {
            //console.log('connection close', arguments);
            connection = {};
            delete connection;
            for (var i in callbacks) {
                delete callbacks[i];
            }
            that.emit('close', e);
            if (config.reconnect) {
                setTimeout(function () {
                    if (autoReconnect) that.connect(config.url);
                }, config.reconnect);
            }

        });

        connection.on('message', function (message) {
            //console.log('connection message', message);
            if (message.type === 'utf8') {
                try {
                    message = JSON.parse(message.utf8Data);
                    //console.log('<--', message);

                    if (callbacks[message.id]) {
                        callbacks[message.id](null, message.payload);
                    }

                } catch (e) {
                    //console.log('<  ', message.utf8Data);
                }


            } else {
                //console.log('<  ', message.toString());
            }
        });

        isPaired = false;

        that.register();

    });

    this.register = function () {

        pairing['client-key'] = that.clientKey || undefined;

        that.send('register', undefined, pairing, function (err, res) {

            if (!err && res) {
                if (!res["client-key"]) {
                    that.emit('prompt');
                } else {
                    that.emit('connect');
                    that.saveKey(res["client-key"]);
                    isPaired = true;
                }
            } else {
                that.emit('error', err);
                //console.log(err, res);
            }

        });
    };

    this.request = function (uri, payload, cb) {
        this.send('request', uri, payload, cb);
    };

    this.subscribe = function (uri, payload, cb) {
        this.send('subscribe', uri, payload, cb);
    };

    this.send = function (type, uri, /* optional */ payload, /* optional */ cb) {
        if (typeof payload === 'function') {
            cb = payload;
            payload = {};
        }

        //console.log(type, connection);

        if (!connection.connected) {
            if (typeof cb === 'function') cb(new Error('not connected'));
            return;
        }

        var cid = getCid();

        var json = JSON.stringify({
            id: cid,
            type: type,
            uri: uri,
            payload: payload
        });

        //console.log('-->', json);

        if (typeof cb === 'function') {

            switch (type)  {
                case 'request':
                    // set callback timeout
                    var timeoutId =
                        setTimeout(function () {
                            // remove callback first, in case the response
                            // comes back while we're processing the error.
                            delete callbacks[cid];

                            // notify of the error.
                            cb(new Error('timeout'));
                        }, config.timeout);

                    callbacks[cid] = function (err, res) {
                        // clear the timeout first, so the callback processing
                        // time doesn't count against the timeout.
                        clearTimeout(timeoutId);

                        // call the callback
                        cb(err, res);

                        // remove callback after first call
                        delete callbacks[cid];
                    };

                    break;

                case 'subscribe':
                    callbacks[cid] = cb;
                    break;

                case 'register':
                    callbacks[cid] = cb;
                    break;
                default:
                    throw new Error('unknown type');
            }
        }
        connection.send(json);
    };

    /**
     *      Connect to TV using a websocket url (eg "ws://192.168.0.100:3000")
     *
     */
    this.connect = function (host) {
        autoReconnect = config.reconnect;

        if (connection.connected && !isPaired) {
            that.register();
        } else if (!connection.connected) {
            that.emit('connecting', host);
            connection = {};
            client.connect(host);
        }
    };

    this.disconnect = function () {
        connection.close();
        autoReconnect = false;
    };

    setTimeout(function () {
        that.connect(config.url);
    }, 0);
};

util.inherits(LGTV, EventEmitter);

module.exports = LGTV;
