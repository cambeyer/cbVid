/*global angular*/
angular.module('cbVidApp', ['cbVidApp.controllers', 'cbVidApp.directives', 'ngAnimate']);

//main Angular module
angular.module('cbVidApp.controllers', ['ngCookies']).controller('mainController', function ($scope, $rootScope, $interval, $timeout, $cookies, $document, $window, $sce) {

	$scope.uploading = {};
	$scope.processing = {};

	$scope.viewers = [];

	$scope.activeVideo = {
		filename: ''
	};

	$scope.videoList = {};

	$scope.authed = false;
	$scope.loading = false;

	$scope.confirmPassword = false;

	$scope.srpClient;
	$scope.srpObj = {};

	$scope.sessionNumber = 0;
	$scope.videoFile;
	$scope.torrentLink;

	$scope.encryptedPhrases = {};

	$scope.fields = {
		username: "",
		password: "",
		passwordConfirm: ""
	};

	//initialize the Socket.IO environment
	/*global io*/
	$scope.socket = io();

	$document.ready(function (){
		$('#username').focus();
		if ($scope.fields.username) {
			$('#password').focus();
		}
	});

	$scope.logout = function () {
		$cookies.remove('username');
		$window.location.reload();
	};

	$scope.uploadFile = function () {
		if (document.getElementById("file").files.length > 0) {
			var oData = new FormData();
			oData.append("username", $scope.fields.username);
			oData.append("session", $scope.sessionNumber);
			oData.append("date", $scope.encrypt(Date.now().toString()));
			oData.append("viewers", JSON.stringify($scope.viewers));
			$scope.viewers = [];
			oData.append("file", document.getElementById("file").files[0]);
			var filename = document.getElementById("file").files[0].name;
			$scope.uploading[filename] = {};
			$scope.uploading[filename].percent = 0;
			var oReq = new XMLHttpRequest();
			oReq.upload.addEventListener('progress', function (e) {
				$scope.$apply(function () {
					$scope.uploading[filename].percent = Math.floor(e.loaded / e.total * 100).toFixed(0);
				});
			}, false);
			oReq.open("post", "upload", true);
			oReq.responseType = "text";
			oReq.onreadystatechange = function () {
				if (oReq.readyState == 4 && oReq.status == 200) {
					var md5 = oReq.response;
					$scope.$apply(function () {
						delete $scope.uploading[filename];
						$scope.processing[md5] = {};
						$scope.processing[md5].percent = 0;
						$scope.sendSubscriptions();
					});
				} else if (oReq.readyState == 4 && oReq.status !== 200) {
					alert("There was an error uploading your file");
				}
			};
			$("#file").replaceWith($("#file").clone());
			oReq.send(oData);
		}
	};

	$scope.socket.on('reconnect', function (num) {
		console.log("Reconnect");
		$scope.$apply(function () {
			$scope.verify();
			$scope.sendSubscriptions();
		});
	});

	$scope.sendSubscriptions = function() {
		for (var md5 in $scope.processing) {
			$scope.socket.emit('subscribe', md5);
		}
	};

	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$scope.fields.passwordConfirm = "";
		$scope.fields.username = $scope.fields.username.replace(/\W/g, '');
	};

	$scope.checkViewers = function () {
		for (var i = 0; i < $scope.viewers.length; i++) {
			$scope.viewers[i].username = $scope.viewers[i].username.replace(/\W/g, '');
		}
	};

	$scope.encrypt = function (text) {
		if (!$scope.encryptedPhrases[text]) {
			$scope.encryptedPhrases[text] = CryptoJS.AES.encrypt(text, $scope.srpClient.getSharedKey()).toString();
		}
		return $scope.encryptedPhrases[text];
	};

	$scope.videoString = function (videoFile) {
		if ($scope.fields.username && $scope.sessionNumber) {
			$scope.videoFile = videoFile;
			/*global btoa*/
			return $sce.trustAsResourceUrl("./download?" + "username=" + $scope.fields.username + "&session=" + $scope.sessionNumber + "&file=" + btoa($scope.encrypt($scope.videoFile)));
		}
	};

	$scope.deleteVideo = function (filename) {
		var delReq = {};
		delReq['username'] = $scope.fields.username;
		delReq['session'] = $scope.sessionNumber;
		delReq['file'] = $scope.encrypt(filename);
		if (confirm("Do you really want to delete this video?")) {
			$scope.socket.emit('delete', delReq);
		}
	};

	$scope.sendTorrent = function () {
		var torrentReq = {};
		torrentReq['username'] = $scope.fields.username;
		torrentReq['session'] = $scope.sessionNumber;
		torrentReq['torrentLink'] = $scope.encrypt($scope.torrentLink);
		torrentReq['viewers'] = JSON.stringify($scope.viewers);
		$scope.viewers = [];
		$scope.torrentLink = "";
		$scope.socket.emit('torrent', torrentReq);
	};

	$scope.removeMe = function (filename) {
		var remReq = {};
		remReq['username'] = $scope.fields.username;
		remReq['session'] = $scope.sessionNumber;
		remReq['file'] = $scope.encrypt(filename);
		if (confirm("Do you really want to remove your access to this video?")) {
			$scope.socket.emit('remove', remReq);
		}
	};

	$scope.setVideo = function (filename) {
		if (filename) {
			if ($scope.activeVideo.filename == filename) {
				return;
			}
			$scope.activeVideo.filename = filename;
		}
		$("#flow").remove();
		if ($scope.activeVideo.filename) {
			$('<div/>', { id: 'flow' }).appendTo('.player');
			$("#flow").flowplayer({
				fullscreen: true,
				native_fullscreen: true,
			    clip: {
			        sources: [
			              {
			              	type: "video/mp4",
			                src:  $scope.videoString($scope.activeVideo.filename)
			              }
			        ]
			    }
			});

			$('.fp-embed').remove();
			$('.fp-brand').remove();
			$('a[href*="flowplayer"]').remove();
			$('.fp-context-menu').addClass('hidden');
			$('.fp-volume').css('right', '40px');
		}
	};

	$interval(function() {
		if ($scope.videoFile && $scope.sessionNumber) {
			var pingObj = {};
			pingObj.hashed = CryptoJS.MD5($scope.videoFile + $scope.sessionNumber).toString();
			pingObj.value = btoa($scope.encrypt(Date.now().toString()).toString());
			$scope.socket.emit('keepalive', pingObj);
		}
	}, 1000);

	$scope.login = function () {
		if ($scope.fields.username && $scope.fields.password) {
			$scope.authed = false;
			$scope.loading = true;
			$scope.sessionNumber = 0;
			if (!$scope.confirmPassword) {
				/*global jsrp*/
				$scope.srpClient = new jsrp.client();
				/*global CryptoJS*/
				$scope.srpClient.init({ username: $scope.fields.username, password: CryptoJS.MD5($scope.fields.password).toString() }, function () {
					$scope.srpObj = {};
					$scope.srpObj.username = $scope.fields.username;
					$scope.srpObj.publicKey = $scope.srpClient.getPublicKey();
					$scope.socket.emit('login', $scope.srpObj);
				});
			} else {
				if ($scope.fields.passwordConfirm == $scope.fields.password) {
					$scope.srpClient.createVerifier(function (err, result) {
						if (!err) {
							$scope.srpObj.salt = result.salt;
							$scope.srpObj.verifier = result.verifier;
							$scope.socket.emit('new', $scope.srpObj);
						} else {
							console.log("Error creating verifier.");
						}
				    });
				} else {
					alert("Your passwords do not match.  Please try again.");
					$scope.fields.passwordConfirm = "";
					$scope.fields.password = "";
					$("#password").focus();
				}
			}
		}
	};

	$scope.socket.on('new', function () {
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.confirmPassword = true;
		});
		$('#confirm').focus();
	});

	$scope.verify = function() {
		var challenge = {};
		challenge.username = $scope.fields.username;
		challenge.sessionNumber = $scope.sessionNumber;
		challenge.encryptedPhrase = $scope.encrypt('client');
		$scope.socket.emit('verify', challenge);
	};

	$scope.socket.on('login', function (srpResponse) {
		$scope.srpClient.setSalt(srpResponse.salt);
		$scope.srpClient.setServerPublicKey(srpResponse.publicKey);
		try {
			$scope.sessionNumber = CryptoJS.AES.decrypt(srpResponse.encryptedPhrase, $scope.srpClient.getSharedKey()).toString(CryptoJS.enc.Utf8);
		} catch (e) { }
		var successBool = (!isNaN($scope.sessionNumber) && $scope.sessionNumber > 0);
		//console.log("Successfully established session: " + $scope.sessionNumber);
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.authed = successBool;
			if (!$scope.authed) {
				$scope.error = true;
				$scope.fields.password = "";
			} else {
				$scope.error = false;
				$cookies.put('username', $scope.fields.username);
				//$scope.fields.password = "";

				$scope.verify();
				//load list of videos from the server
			}
		});
	});

	$scope.socket.on('progress', function (msg){
		$scope.$apply(function () {
			var percent = Math.floor(msg.percent).toFixed(0);
			$scope.processing[msg.md5].percent = percent;
			if (percent >= 100) {
				try {
					delete $scope.processing[msg.md5];
				} catch (e) {}
			}
		});
	});

	$scope.socket.on('torrent', function (msg) {
		$scope.$apply(function () {
			$scope.processing[msg.md5] = {};
			$scope.processing[msg.md5].percent = 0;
			$scope.sendSubscriptions();
		});
	});

	$scope.socket.on('list', function (videoList) {
		$scope.$apply(function () {
			if (videoList.username == $scope.fields.username) {
				for (var i = 0; i < videoList.edit.length; i++) {
					videoList.edit[i].edit = true;
				}
				for (var i = 0; i < videoList.view.length; i++) {
					videoList.view[i].edit = false;
				}
				$scope.videoList = [].concat(videoList.edit).concat(videoList.view);
				var found = false;
				for (var i = 0; i < $scope.videoList.length; i++) {
					if ($scope.videoList[i].filename == $scope.activeVideo.filename) {
						found = true;
						break;
					}
				}
				if (!found) {
					if ($scope.videoList.length > 0) {
						$scope.activeVideo.filename = $scope.videoList[0].filename;
					} else {
						$scope.activeVideo.filename = "";
					}
					$scope.setVideo();
				}
			}
		});
	});

	//Perform after all of the functions have been defined

	if ($cookies.get('username')) {
		$scope.fields.username = $cookies.get('username');
	}
});