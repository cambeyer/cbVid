var express = require('express');
var app = express();
var busboy = require('connect-busboy');
var path = require('path');
var fs = require('fs-extra');
var http = require('http').Server(app);
var send = require('send');
var request = require('request');
var io = require('socket.io')(http);
var parseTorrent = require('parse-torrent');
var torrentStream = require('torrent-stream');
var ytdl = require('ytdl-core');
var crypto = require('crypto');
var node_cryptojs = require('node-cryptojs-aes');
var CryptoJS = node_cryptojs.CryptoJS;
var ffmpeg = require('fluent-ffmpeg');
var nedb = require('nedb');
var jsrp = require('jsrp');
var atob = require('atob');

//set the directory where files are served from and uploaded to
var dir = __dirname + '/files/';
//ensure the directory exists
fs.mkdir(dir, function(err) {
    if (err && err.code !== 'EEXIST') {
    	console.log("Error creating folder");
    }
});

app.use(busboy());

//files in the public directory can be directly queried for via HTTP
app.use(express.static(path.join(__dirname, 'public')));

//set up smtp service for sending email
//var transport = nodemailer.createTransport("direct", {debug: false});

var EMAIL_FROM_NAME = "cbVid";
var EMAIL_FROM_ADDRESS = "no-reply@cbvid.com";

var processing = {};
var torrenting = {};
var done = [];

var userKeys = {};

var torrentAPI = "https://torrentapi.org/pubapi_v2.php?app_id=cbvid&";

var DB_EXT = '.db';

var db = {};
db.users = new nedb({ filename: dir + "users" + DB_EXT, autoload: true });
db.users.persistence.setAutocompactionInterval(200000);
db.users.ensureIndex({ fieldName: 'username', unique: true });

db.videos = new nedb({ filename: dir + "videos" + DB_EXT, autoload: true});
db.videos.persistence.setAutocompactionInterval(200000);
db.videos.ensureIndex({ fieldName: 'filename', unique: true });

var getFiles = function (dir, recurse, files_) {
    files_ = files_ || [];
    var files = fs.readdirSync(dir);
    for (var i in files) {
        var name = dir + '/' + files[i];
        if (fs.statSync(name).isDirectory()) {
        	if (recurse) {
            	getFiles(name, recurse, files_);
        	}
        } else {
            files_.push(name);
        }
    }
    return files_;
};

var cleanup = function() {
	var files = getFiles(dir);
	for (var i = 0; i < files.length; i++) {
		if (files[i].split(DB_EXT).length <= 1) {
			checkRemove(files[i].split('/')[files[i].split('/').length - 1]);
		}
	}
	db.videos.find({ }, function(err, videos) {
		if (!err) {
			for (var i = 0; i < videos.length; i++) {
				if (videos[i].filename) {
					try {
						fs.statSync(dir + videos[i].filename);
					} catch (e) {
						db.videos.remove({ filename: videos[i].filename }, {}, function(err, numRemoved) {
							if (!err) {
								console.log("Removed " + numRemoved + " abandoned records.");
							}
						});
					}
				}
			}
		}
	});
};

var checkRemove = function(name) {
	db.videos.find({ filename: name }, function(err, videos) {
		if (!err && videos.length == 0) {
			try {
				console.log("Removing " + dir + name);
				fs.unlinkSync(dir + name);
			} catch (e) { }
		} else if (videos.length == 1) {
			var permissions = videos[0].permissions;
			for (var i = 0; i < permissions.length; i++) {
				if (permissions[i].isowner == "true") {
					db.users.find({ username: permissions[i].username }, function(err, users) {
						if (!err && users.length == 0) {
							try {
								console.log("Removing " + dir + name);
								fs.unlinkSync(dir + name);
							} catch (e) { }
						}
					});
				}
			}
		}
	});
};

var sendMail = function(recipient, subject, text) {
	transport.sendMail({
	    from: EMAIL_FROM_NAME + " <" + EMAIL_FROM_ADDRESS + ">",
	    to: recipient,
	    subject: subject,
	    text: text
	}, function(error, info){
	    if (error) {
	        console.log(error);
	    }
	});
};

app.route('/upload').post(function (req, res, next) {
	var hash = crypto.createHash('md5');
	var sessionVars = {};
	var fstream;
	var filename;
	req.on('close', function () {
		if (fstream && filename) {
			fstream.end();
	        fs.unlinkSync(filename);
		}
        console.log("Client disconnected while uploading");
	});
	req.busboy.on('field', function (fieldname, val) {
		sessionVars[fieldname] = val;
		if (sessionVars.username && sessionVars.session && sessionVars.date) {
			sessionVars.ddate = decrypt(sessionVars.username, sessionVars.session, sessionVars.date);
		}
	});
	req.busboy.on('file', function (fieldname, stream, name) {
		console.log("Uploading file: " + name);
		sessionVars.name = name;
		filename = dir + getName(path.basename(name));
		fstream = fs.createWriteStream(filename);
		stream.on('data', function (chunk) {
			hash.update(chunk);
		});
		fstream.on('close', function () {
			sessionVars.md5 = getName(hash.digest('hex'));
			res.writeHead(200, { Connection: 'close' });
      		res.end(sessionVars.md5);

			transcode(filename, sessionVars);
		});
		stream.pipe(fstream);
	});
	req.busboy.on('finish', function () {
		//processing form complete
	});
	req.pipe(req.busboy);
});

var transcode = function (file, sessionVars) {
	var percent;
	var timestamp;
	var command = ffmpeg(file)
		.videoBitrate('1024k')
		.videoCodec('libx264')
		.fps(30)
		.audioBitrate('128k')
		.audioCodec('aac')
		.audioChannels(2)
		.format('mp4')
		.outputOption('-pix_fmt yuv420p')
		.outputOption('-movflags faststart')
		.outputOption('-analyzeduration 2147483647')
		.outputOption('-probesize 2147483647')
		.on('start', function (cmdline) {
			console.log("Beginning transcode");
		})
		.on('progress', function (progress) {
			clearTimeout(timeout);
			percent = progress.percent;
			timestamp = progress.timemark;
			if (processing[sessionVars.md5]) {
				var resp = { md5: sessionVars.md5, timestamp: progress.timemark, name: sessionVars.name, type: 'processing' };
				if (progress.percent) {
					resp.percent = progress.percent;
				}
				processing[sessionVars.md5].emit('progress', resp);
			} else if (progress.percent > 50) {
				console.log("Transcoding without a client listener (>50%)");
			}
			//console.log('Transcoding progress ' + sessionVars.md5);
		})
		.on('end', function () {
			if (processing[sessionVars.md5] && !processing[sessionVars.md5].disconnected) {
				processing[sessionVars.md5].emit('progress', { md5: sessionVars.md5, percent: 100, type: 'processing' });
				console.log('File has been transcoded successfully: ' + sessionVars.md5);
			} else {
				done.push({ md5: sessionVars.md5, type: 'processing' });
				console.log("Completed without an active listener: " + sessionVars.md5);
			}
			delete processing[sessionVars.md5];
			if (sessionVars.ddate) {
				//username: sessionVars.username
				var vidDetails = {};
				vidDetails['filename'] = sessionVars.md5;
				vidDetails['details'] = { date: sessionVars.ddate, original: sessionVars.name }; //populate this with title, description, etc.
				vidDetails['permissions'] = [];
				vidDetails['permissions'].push({ username: sessionVars.username, isowner: "true" });
				var viewers = [];
				try {
					viewers = JSON.parse(sessionVars.viewers);
				} catch (e) { }
				for (var i = 0; i < viewers.length; i++) {
					if (viewers[i].username && viewers[i].username !== sessionVars.username) { //make sure the owner isnt denied permission to edit their own file
						vidDetails['permissions'].push({ username: viewers[i].username, isowner: "false" });
					}
				}
				db.videos.insert(vidDetails, function (err) {
					if (!err) {
						try {
							if (!sessionVars.keep) {
								fs.unlinkSync(file); //remove the initially uploaded file... could retain this for auditing purposes
							} else {
								console.log("Retaining file");
							}
						} catch (e) { }
						for (var i = 0; i < vidDetails.permissions.length; i++) {
							console.log("Sending video list");
							sendList(vidDetails.permissions[i].username);
						}
					} else {
						console.log("DB insert error");
					}
				});
			}
		})
		.on('error', function (err, stdout, stderr) {
			//console.log("Transcoding issue: " + err + stderr);
			if (processing[sessionVars.md5] && !processing[sessionVars.md5].disconnected) {
				processing[sessionVars.md5].emit('progress', { md5: sessionVars.md5, percent: 100, type: 'processing' });
			} else {
				done.push({ md5: sessionVars.md5, type: 'processing' });
			}
			delete processing[sessionVars.md5];
			console.log('File has been abandoned due to error: ' + sessionVars.md5);
			try {
				fs.statSync(file);
				fs.unlinkSync(file);
			} catch (e) { }
			try {
				fs.statSync(dir + sessionVars.md5);
				fs.unlinkSync(dir + sessionVars.md5);
			} catch (e) { }
			clearTimeout(timeout);
		})
		.save(dir + sessionVars.md5);

		var timeout = setTimeout(function() {
			if (!percent && !timestamp) {
				console.log("No progress has been made; killing the process.");
				command.kill();
			}
		}, 60000);
};

app.get('/download.mp4', function (req, res){
	var encryptedName = atob(req.query.file);
	var filename = decrypt(req.query.username, req.query.session, encryptedName);
	if (filename) {
		db.videos.findOne({ filename: filename, "permissions.username": req.query.username }, { _id: 0 }, function (err, video) {
			if (!err && video) {
				removeFromDone(filename);
				var file = path.resolve(dir, filename);
				fs.stat(file, function(err, stats) {
					if (err) {
						deleteVideo(filename);
						res.writeHead(404, {"Content-Type":"text/plain"});
						res.end("Could not read file");
						return;
					}
		
					send(req, file, {maxAge: '10h'})
						.on('error', function(err) {
							console.log(err);
						})
						.on('headers', function(res, path, stat) {
							res.setHeader('Content-Type', 'video/mp4');
						})
						.pipe(res);
				});
			} else {
				res.sendStatus(401);
			}
		});
	} else {
		res.sendStatus(401);
	}
});

var createSRPResponse = function (socket, user) {
	var srpServer = new jsrp.server();
	srpServer.init({ salt: user.salt, verifier: user.verifier }, function () {
		srpServer.setClientPublicKey(user.publicKey);
		var srpMsg = {};
		srpMsg.salt = srpServer.getSalt();
		srpMsg.publicKey = srpServer.getPublicKey();
		var sessionNumber = Date.now().toString();
		if (!userKeys[user.username]) {
			userKeys[user.username] = {keys: []};
		}
		var key = {};
		key.content = srpServer.getSharedKey();
		key.sessionNumber = sessionNumber;
		key.verified = false;
		userKeys[user.username].keys.push(key);
		srpMsg.encryptedPhrase = encrypt(user.username, sessionNumber, sessionNumber, true);
		socket.emit('login', srpMsg);
	});
};

var getKey = function (username, sessionNumber) {
	var key;
	if (userKeys[username]) {
		for (var i = 0; i < userKeys[username].keys.length; i++) {
			if (userKeys[username].keys[i].sessionNumber < Date.now() - 86400000) { //24 hour timeout
				userKeys[username].keys.splice(i, 1);
				i--;
				continue;
			}
			if (!key && userKeys[username].keys[i].sessionNumber == sessionNumber) {
				key = userKeys[username].keys[i];
			}
		}
	}
	return key;
};

var decrypt = function (username, sessionNumber, text, disregardVerification) {
	var key = getKey(username, sessionNumber);
	if (key) {
		try {
			if (disregardVerification || key.verified) {
				return CryptoJS.AES.decrypt(text, key.content).toString(CryptoJS.enc.Utf8);
			}
		} catch (e) { }
	}
};

var encryptedPhrases = {};

var encrypt = function(username, sessionNumber, text, disregardVerification) {
	var key = getKey(username, sessionNumber);
	if (key) {
		try {
			if (disregardVerification || key.verified) {
				if (!encryptedPhrases[username]) {
					encryptedPhrases[username] = {};
				}
				if (!encryptedPhrases[username][sessionNumber]) {
					encryptedPhrases[username][sessionNumber] = {};
				}
				if (!encryptedPhrases[username][sessionNumber][text]) {
					encryptedPhrases[username][sessionNumber][text] = CryptoJS.AES.encrypt(text, key.content).toString();
				}
				return encryptedPhrases[username][sessionNumber][text];
			}
		} catch (e) { }
	}
};

var sendList = function (username, socket) {
	var vidList = {};
	vidList['username'] = username;
	db.videos.find({ permissions: { username: username, isowner: "true" } }, { _id: 0 }, function (err, videos) {
		if (!err) {
			vidList['edit'] = videos;
			db.videos.find({ permissions: { username: username, isowner: "false" } }, { permissions: 0, _id: 0 }, function (err, videos) {
				if (!err) {
					vidList['view'] = videos;
					if (socket) {
						socket.emit('list', vidList);
					} else {
						io.emit('list', vidList);
					}
				}
			});
		}
	});
};

var fetchTorrentList = function(query, socket) {
	request(torrentAPI + "get_token=get_token", function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var torURL = torrentAPI + "token=" + JSON.parse(body).token + "&search_string=" + query + "&mode=search&min_seeders=5&limit=100&category=1;14;48;17;44;45;42;18;41&sort=seeders&format=json_extended";
			//console.log(torURL);
			request(torURL, function (error, response, body) {
				if (!error && response.statusCode == 200) {
					var results = JSON.parse(body).torrent_results;
					var final = [];
					if (results) {
						for (var i = 0; i < results.length; i++) {
							//if (results[i].category.indexOf("1080") >= 0 || results[i].category.indexOf("720") >= 0) {
								final.push({title: results[i].title, download: results[i].download});
							//}
						}
					} else {
						if (JSON.parse(body).error_code && JSON.parse(body).error_code !== 20) {
							console.log(body);
						}
					}
					socket.emit('listtorrent', final);
				}
			});
		}
	});
};

var deleteVideo = function (md5) {
	db.videos.findOne({ filename: md5 }, function(err, video) {
		if (!err && video) {
			var affected = [];
			for (var i = 0; i < video.permissions.length; i++) {
				affected.push(video.permissions[i].username);
			}
			db.videos.remove({ filename: md5 }, {}, function (err, numRemoved) {
				if (!err) {
					try {
						fs.unlinkSync(dir + md5);
					} catch (e) { }
					console.log("Deleted " + md5);
					for (var i = 0; i < affected.length; i++) {
						sendList(affected[i]);
					}
				}
			});
		}
	});
};

var getName = function(filename) {
	var num = 0;
	var exists = true;
	while (exists) {
		try {
			fs.statSync(dir + filename + num);
			num = num + 1;
		} catch (e) {
			filename = filename + num;
			exists = false;
		}
	}
	return filename;
};

var doTorrent = function(socket, sessionVars, engine, file) {
	console.log("Torrenting file: " + file.name + ", size: " + file.length);
	var downloaded = 0;
	var stream = file.createReadStream();
	sessionVars.name = file.name;
	var filename = getName(file.name);
	var filesize = file.length;

	socket.emit('procuring', { md5: filename, name: sessionVars.name });
	var hash = crypto.createHash('md5');
	var fstream = fs.createWriteStream(dir + filename);
	stream.on('data', function (chunk) {
		hash.update(chunk);
		downloaded = downloaded + chunk.length;
		var percent = downloaded / filesize * 100;
		socket.emit('progress', { md5: filename, percent: percent, type: 'procuring', name: sessionVars.name });
	});
	stream.on('error', function(err) {
		try {
			fs.unlinkSync(dir + filename);
		} catch (e) { }
		removeFromTorrenting(sessionVars, engine);
		console.log("Error streaming torrent " + err);
	});
	fstream.on('close', function () {
		removeFromTorrenting(sessionVars, engine);
		if (!socket.disconnected) {
			socket.emit('progress', { md5: filename, percent: 100, type: 'procuring', name: sessionVars.name });
		} else {
			done.push({ md5: filename, type: 'procuring' });
		}

		sessionVars.md5 = getName(hash.digest('hex'));
		sessionVars.ddate = String(Date.now());
		socket.emit('processing', {name: sessionVars.name, md5: sessionVars.md5});
		transcode(dir + filename, sessionVars);
	});
	stream.pipe(fstream);
};

var removeFromDone = function(md5) {
	for (var i = 0; i < done.length; i++) {
		if (done[i].md5 == md5) {
			done.splice(i, 1);
			return;
		}
	}
};

var removeFromTorrenting = function(sessionVars, engine) {
	var arr = torrenting[sessionVars.torrentLink];
	for (var i = 0; i < arr.length; i++) {
		if (arr[i] == sessionVars.name) {
			arr.splice(i, 1);
			break;
		}
	}
	if (arr.length == 0) {
		delete torrenting[sessionVars.torrentLink];
		engine.remove(false, function() {
			console.log("Removed torrent temp data");
		});
	} else {
		console.log("Another process is using the same torrent data.  Leaving intact.");
	}
};

io.on('connection', function (socket) {
	socket.disconnected = false;
	socket.on('disconnect', function () {
		socket.disconnected = true;
	});
	socket.on('subscribe', function (md5) {
		//console.log("Subscription from client for updates " + md5);
		for (var i = 0; i < done.length; i++) {
			if (done[i].md5 == md5) {
				//console.log("File finished activity before client subscription; sending that information back to the client");
				socket.emit('progress', { md5: md5, percent: 100, type: done[i].type });
				return;
			}
		}
		if (!processing[md5]) {
			socket.emit('progress', { md5: md5, percent: 0, type: 'processing' });
		}
		processing[md5] = socket;
	});
	socket.on('unsubscribe', function(md5) {
		removeFromDone(md5);
	});
	socket.on('new', function (newUser) {
		var userObj = {};
		userObj.username = newUser.username;
		userObj.salt = newUser.salt;
		userObj.verifier = newUser.verifier;
		db.users.insert(userObj, function (err) {
			if (!err) {
				console.log("Registered new user: " + newUser.username);
				userObj.publicKey = newUser.publicKey;
				createSRPResponse(socket, userObj);
			} else {
				console.log("DB insert error");
			}
		});
	});
	socket.on('login', function (srpObj) {
		db.users.findOne({ username: srpObj.username }, function (err, userObj) {
			if (!err) {
				if (!userObj) {
					socket.emit('new');
				} else {
					userObj.publicKey = srpObj.publicKey;
					createSRPResponse(socket, userObj);
				}
			} else {
				console.log("DB lookup error");
			}
		});
	});
	socket.on('update', function(updReq) {
		var updateVideo = decrypt(updReq.username, updReq.session, updReq.updateVideo);
		if (updateVideo) {
			updateVideo = JSON.parse(updateVideo);
			updateVideo['permissions'].push({ username: updReq.username, isowner: "true" });
			db.videos.findOne({filename: updateVideo.filename, permissions: { username: updReq.username, isowner: "true" }}, { _id: 0 }, function (err, video) {
				if (!err && video) {
					db.videos.update({filename: updateVideo.filename, permissions: { username: updReq.username, isowner: "true" }}, updateVideo, {}, function (err) {
						if (!err) {
							var sent = {};
							for (var i = 0; i < video.permissions.length; i++) {
								sendList(video.permissions[i].username);
								sent[video.permissions[i].username] = true;
							}
							for (var i = 0; i < updateVideo.permissions.length; i++) {
								if (!sent[updateVideo.permissions[i].username]) {
									sendList(updateVideo.permissions[i].username);
								}
							}
						} else {
							console.log("DB update error " + err);
						}
					});
				}
			});
		}
	});
	socket.on('delete', function (delReq) {
		var md5 = decrypt(delReq.username, delReq.session, delReq.file);
		if (md5) {
			deleteVideo(md5);
		}
	});
	socket.on('remove', function (remReq) {
		var md5 = decrypt(remReq.username, remReq.session, remReq.file);
		if (md5) {
			db.videos.findOne({ filename: md5 }, function (err, video) {
				if (!err) {
					for (var i = 0; i < video.permissions.length; i++) {
						if (video.permissions[i].username == remReq.username) {
							video.permissions.splice(i, 1);
							break;
						}
					}
					db.videos.update({ filename: md5 }, { $set: { permissions: video.permissions } }, function (err) {
						if (!err) {
							console.log("Removed access for " + remReq.username + " to " + md5);
							sendList(remReq.username);
							for (var i = 0; i < video.permissions.length; i++) {
								sendList(video.permissions[i].username);
							}
						}
					});
				}
			});
		}
	});
	socket.on('verify', function (challenge) {
		if (decrypt(challenge.username, challenge.session, challenge.encryptedPhrase, true) == "client") {
			console.log("Successfully logged in user: " + challenge.username);
			getKey(challenge.username, challenge.session).verified = true;
			socket.emit('verifyok', 'true');
		} else {
			console.log("Failed login for user: " + challenge.username);
			socket.emit('verifyok', 'false');
		}
	});
	socket.on('list', function (vidReq) {
		if (decrypt(vidReq.username, vidReq.session, vidReq.encryptedPhrase) == "list") {
			sendList(vidReq.username, socket);
		} else {
			socket.emit('verifyok', 'false');
		}
	});
	socket.on('listtorrent', function(torReq) {
		if (decrypt(torReq.username, torReq.session, torReq.encryptedPhrase) == "listtorrent") {
			fetchTorrentList(torReq.query, socket);
		} else {
			socket.emit('verifyok', 'false');
		}
	});
	socket.on('logout', function (logoutReq) {
		if (decrypt(logoutReq.username, logoutReq.session, logoutReq.verification, true) == "logout") {
			for (var i = 0; i < userKeys[logoutReq.username].keys.length; i++) {
				if (userKeys[logoutReq.username].keys[i].sessionNumber == logoutReq.session) {
					userKeys[logoutReq.username].keys.splice(i, 1);
					var resp = {};
					resp.username = logoutReq.username;
					resp.session = logoutReq.session;
					io.emit('logout', resp);
					console.log("Successfully logged out user: " + logoutReq.username);
					break;
				}
			}
		}
	});
	socket.on('torrent', function(sessionVars) {
		sessionVars.torrentLink = decrypt(sessionVars.username, sessionVars.session, sessionVars.torrentLink);
		if (sessionVars.torrentLink) {
			try {
				console.log("Initializing torrent request");
				parseTorrent.remote(sessionVars.torrentLink, function (err, parsedTorrent) {
					if (!err) {
						sessionVars.torrentLink = parseTorrent.toMagnetURI(parsedTorrent);
						var engine = torrentStream(sessionVars.torrentLink, {
							verify: true,
							dht: true,
							tmp: dir
						});
						engine.on('ready', function() {
							if (engine.files.length > 0) {
								for (var i = 0; i < engine.files.length; i++) {
									if (engine.files[i].length > 1000000) {
										if (!torrenting[sessionVars.torrentLink]) {
											torrenting[sessionVars.torrentLink] = [];
										}
										torrenting[sessionVars.torrentLink].push(engine.files[i].name);
										doTorrent(socket, JSON.parse(JSON.stringify(sessionVars)), engine, engine.files[i]);
									}
								}
							}
						});
					}
				});
			} catch (e) {
				console.log("Abandoned torrent due to an error");
			}
		}
	});
	socket.on('ingest', function(sessionVars) {
		sessionVars.ingestLink = decrypt(sessionVars.username, sessionVars.session, sessionVars.ingestLink);
		if (sessionVars.ingestLink) {
			try {
				console.log("Initiating ingest request");

				var downloaded = 0;
				var filesize;
				var stream;
				if (sessionVars.ingestLink.split('youtube.com').length > 1) {
					console.log("Downloading from YouTube");
					stream = ytdl(String(sessionVars.ingestLink), { filter: function(format) { return format.container === 'mp4'; } });
				} else {
					stream = request(sessionVars.ingestLink);
				}

				var filename = sessionVars.ingestLink.split("/")[sessionVars.ingestLink.split("/").length - 1].split("?")[0];
				filename = filename ? filename : "ingested";
				sessionVars.name = String(filename);

				filename = getName(filename);

				var hash = crypto.createHash('md5');
				var fstream = fs.createWriteStream(dir + filename);
				stream.on('info', function(info) {
					sessionVars.name = info.title;
				});
				stream.on('data', function (chunk) {
					hash.update(chunk);
					downloaded = downloaded + chunk.length;
					var percent = downloaded / filesize * 100;
					socket.emit('progress', { md5: filename, percent: percent, type: 'procuring', name: sessionVars.name });
				});
				stream.on('error', function(err) {
					try {
						fs.unlinkSync(dir + filename);
					} catch (e) { }
					console.log("Error streaming ingest " + err);
				});
				stream.on('response', function (data) {
					socket.emit('procuring', { md5: filename, name: sessionVars.name });
					filesize = data.headers['content-length'];
				});
				fstream.on('close', function () {
					sessionVars.md5 = hash.digest('hex');
					if (!socket.disconnected) {
						socket.emit('progress', { md5: filename, percent: 100, type: 'procuring', name: sessionVars.name });
					} else {
						done.push({ md5: filename, type: 'procuring' });
					}
					sessionVars.md5 = getName(sessionVars.md5);
					sessionVars.ddate = String(Date.now());
					socket.emit('processing', {name: sessionVars.name, md5: sessionVars.md5});
					transcode(dir + filename, sessionVars);
				});
				stream.pipe(fstream);
			} catch (e) { }
		}
	});
});

http.listen(80, "0.0.0.0", function (){
	console.log('listening on *:80');
	cleanup();
	//sendMail("cam.beyer@gmail.com", "Email test", "This is a test");
});