/*global angular*/
angular.module('cbVidApp', ['cbVidApp.controllers', 'cbVidApp.directives', 'cbVidApp.services', 'ngAnimate']);

//main Angular module
angular.module('cbVidApp.controllers', ['ngCookies', 'ui.bootstrap']).controller('mainController', function ($scope, $rootScope, $interval, $timeout, $cookies, $document, $window, $sce, $modal, EncryptService) {

	$scope.activeVideo;
	
	$scope.viewers = [];
	
	$rootScope.uploading = {};
	$scope.uploadModal;
	$rootScope.processing = {};
	$scope.progressModal;

	$scope.videoList = {};

	$scope.authed = false;
	$scope.loading = false;

	$scope.confirmPassword = false;

	$rootScope.srpClient;
	$scope.srpObj = {};

	$rootScope.sessionNumber = 0;
	$scope.videoFile;

	$rootScope.fields = {
		username: "",
		password: "",
		passwordConfirm: ""
	};

	//initialize the Socket.IO environment
	/*global io*/
	$rootScope.socket = io();

	$document.ready(function (){
		$('#username').focus();
		if ($rootScope.fields.username) {
			$('#password').focus();
		}
	});

	$scope.logout = function () {
		$cookies.remove('username');
		$window.location.reload();
	};
	
	$scope.showUploadDialog = function () {
		$scope.uploadModal = $modal.open({
			animation: true,
			templateUrl: 'uploadForm.html',
			controller: 'UploadForm',
			size: 'md',
			scope: $scope
		});

		$scope.uploadModal.result.then(function (shouldShowProgress) {
			if (shouldShowProgress) {
				$scope.showProgressDialog();
			}
		});
	};
	
	$scope.showProgressDialog = function () {
		$scope.progressModal = $modal.open({
			animation: true,
			templateUrl: 'progressForm.html',
			controller: 'ProgressForm',
			size: 'md',
			scope: $scope
		});
	};

	$rootScope.socket.on('reconnect', function (num) {
		console.log("Reconnect");
		$scope.$apply(function () {
			$scope.verify();
			$rootScope.sendSubscriptions();
		});
	});
	
	$rootScope.sendSubscriptions = function() {
		for (var md5 in $rootScope.processing) {
			$rootScope.socket.emit('subscribe', md5);
		}
	};

	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$rootScope.fields.passwordConfirm = "";
		$rootScope.fields.username = $rootScope.fields.username.replace(/\W/g, '');
	};

	$scope.videoString = function (videoFile) {
		if ($rootScope.fields.username && $rootScope.sessionNumber) {
			$scope.videoFile = videoFile;
			/*global btoa*/
			return $sce.trustAsResourceUrl("./download?" + "username=" + $rootScope.fields.username + "&session=" + $rootScope.sessionNumber + "&file=" + btoa(EncryptService.encrypt($scope.videoFile)));
		}
	};

	$scope.deleteVideo = function (filename) {
		var delReq = {};
		delReq['username'] = $rootScope.fields.username;
		delReq['session'] = $rootScope.sessionNumber;
		delReq['file'] = EncryptService.encrypt(filename);
		if (confirm("Do you really want to delete this video?")) {
			$rootScope.socket.emit('delete', delReq);
		}
	};

	$scope.removeMe = function (filename) {
		var remReq = {};
		remReq['username'] = $rootScope.fields.username;
		remReq['session'] = $rootScope.sessionNumber;
		remReq['file'] = EncryptService.encrypt(filename);
		if (confirm("Do you really want to remove your access to this video?")) {
			$rootScope.socket.emit('remove', remReq);
		}
	};

	$scope.setVideo = function (file) {
		if (file) {
			if ($scope.activeVideo.filename == file.filename) {
				return;
			}
			$scope.activeVideo = file;
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
		if ($scope.videoFile && $rootScope.sessionNumber) {
			var pingObj = {};
			pingObj.hashed = CryptoJS.MD5($scope.videoFile + $rootScope.sessionNumber).toString();
			pingObj.value = btoa(EncryptService.encrypt(Date.now().toString()).toString());
			$rootScope.socket.emit('keepalive', pingObj);
		}
	}, 1000);

	$scope.login = function () {
		if ($rootScope.fields.username && $rootScope.fields.password) {
			$scope.authed = false;
			$scope.loading = true;
			$rootScope.sessionNumber = 0;
			if (!$scope.confirmPassword) {
				/*global jsrp*/
				$rootScope.srpClient = new jsrp.client();
				/*global CryptoJS*/
				$rootScope.srpClient.init({ username: $rootScope.fields.username, password: CryptoJS.MD5($rootScope.fields.password).toString() }, function () {
					$scope.srpObj = {};
					$scope.srpObj.username = $rootScope.fields.username;
					$scope.srpObj.publicKey = $rootScope.srpClient.getPublicKey();
					$rootScope.socket.emit('login', $scope.srpObj);
				});
			} else {
				if ($rootScope.fields.passwordConfirm == $rootScope.fields.password) {
					$rootScope.srpClient.createVerifier(function (err, result) {
						if (!err) {
							$scope.srpObj.salt = result.salt;
							$scope.srpObj.verifier = result.verifier;
							$rootScope.socket.emit('new', $scope.srpObj);
						} else {
							console.log("Error creating verifier.");
						}
				    });
				} else {
					alert("Your passwords do not match.  Please try again.");
					$rootScope.fields.passwordConfirm = "";
					$rootScope.fields.password = "";
					$("#password").focus();
				}
			}
		}
	};
	
	$scope.uploadFile = function () {
		if (document.getElementById("file").files.length > 0) {
			var oData = new FormData();
			oData.append("username", $rootScope.fields.username);
			oData.append("session", $rootScope.sessionNumber);
			oData.append("date", EncryptService.encrypt(Date.now().toString()));
			oData.append("viewers", JSON.stringify($scope.viewers));
			$scope.viewers = [];
			oData.append("file", document.getElementById("file").files[0]);
			var filename = document.getElementById("file").files[0].name;
			$rootScope.uploading[filename] = {};
			$rootScope.uploading[filename].percent = 0;
			var oReq = new XMLHttpRequest();
			oReq.upload.addEventListener('progress', function (e) {
				$scope.$apply(function () {
					$rootScope.uploading[filename].percent = Math.floor(e.loaded / e.total * 100).toFixed(0);
				});
			}, false);
			oReq.open("post", "upload", true);
			oReq.responseType = "text";
			oReq.onreadystatechange = function () {
				if (oReq.readyState == 4 && oReq.status == 200) {
					var md5 = oReq.response;
					$scope.$apply(function () {
						delete $rootScope.uploading[filename];
						$rootScope.processing[md5] = {};
						$rootScope.processing[md5].percent = 0;
						$rootScope.sendSubscriptions();
					});
				} else if (oReq.readyState == 4 && oReq.status !== 200) {
					alert("There was an error uploading your file");
				}
			};
			$("#file").replaceWith($("#file").clone());
			oReq.send(oData);
		}
	};

	$rootScope.socket.on('new', function () {
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.confirmPassword = true;
		});
		$('#confirm').focus();
	});

	$scope.verify = function() {
		var challenge = {};
		challenge.username = $rootScope.fields.username;
		challenge.sessionNumber = $rootScope.sessionNumber;
		challenge.encryptedPhrase = EncryptService.encrypt('client');
		$rootScope.socket.emit('verify', challenge);
	};

	$rootScope.socket.on('login', function (srpResponse) {
		$rootScope.srpClient.setSalt(srpResponse.salt);
		$rootScope.srpClient.setServerPublicKey(srpResponse.publicKey);
		try {
			$rootScope.sessionNumber = CryptoJS.AES.decrypt(srpResponse.encryptedPhrase, $rootScope.srpClient.getSharedKey()).toString(CryptoJS.enc.Utf8);
		} catch (e) { }
		var successBool = (!isNaN($rootScope.sessionNumber) && $rootScope.sessionNumber > 0);
		//console.log("Successfully established session: " + $rootScope.sessionNumber);
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.authed = successBool;
			if (!$scope.authed) {
				$scope.error = true;
				$rootScope.fields.password = "";
			} else {
				$scope.error = false;
				$cookies.put('username', $rootScope.fields.username);
				//$rootScope.fields.password = "";

				$scope.verify();
				//load list of videos from the server
			}
		});
	});

	$rootScope.socket.on('progress', function (msg){
		$scope.$apply(function () {
			var percent;
			if (msg.percent) {
				percent = Math.floor(msg.percent).toFixed(0);
				$rootScope.processing[msg.md5].percent = percent;
			} else {
				delete $rootScope.processing[msg.md5].percent;
			}
			$rootScope.processing[msg.md5].timestamp = msg.timestamp;
			if (!$rootScope.processing[msg.md5].name && msg.name) {
				$rootScope.processing[msg.md5].name = msg.name;
			}
			if (percent >= 100) {
				try {
					delete $rootScope.processing[msg.md5];
					if (Object.keys($rootScope.processing).length == 0 && Object.keys($rootScope.uploading).length == 0) {
						$scope.progressModal.close();
					}
				} catch (e) {}
			}
		});
	});

	$rootScope.socket.on('torrent', function (md5) {
		$scope.$apply(function () {
			$rootScope.processing[md5] = {};
			$rootScope.processing[md5].percent = 0;
			$rootScope.sendSubscriptions();
		});
	});

	$rootScope.socket.on('list', function (videoList) {
		$scope.$apply(function () {
			if (videoList.username == $rootScope.fields.username) {
				for (var i = 0; i < videoList.edit.length; i++) {
					videoList.edit[i].edit = true;
				}
				for (var i = 0; i < videoList.view.length; i++) {
					videoList.view[i].edit = false;
				}
				$scope.videoList = [].concat(videoList.edit).concat(videoList.view);
				var found = false;
				if ($scope.activeVideo) {
					for (var i = 0; i < $scope.videoList.length; i++) {
						if ($scope.videoList[i].filename == $scope.activeVideo.filename) {
							found = true;
							break;
						}
					}
				}
				if (!found) {
					if ($scope.videoList.length > 0) {
						$scope.activeVideo = $scope.videoList[0];
					} else {
						$scope.activeVideo = "";
					}
					$scope.setVideo();
				}
			}
		});
	});

	//Perform after all of the functions have been defined

	if ($cookies.get('username')) {
		$rootScope.fields.username = $cookies.get('username');
	}
})
.controller('UploadForm', function ($scope, $modalInstance, $rootScope, EncryptService) {
	
	$scope.type = "file";
	$scope.torrent = {
		magnet: ''
	};
	
	$scope.ok = function () {
		$modalInstance.close(false);
	};
	/*
	$scope.$on('modal.closing', function(event, reason, closed) {
		event.preventDefault();
	});
	*/
	
	$scope.checkViewers = function () {
		for (var i = 0; i < $scope.viewers.length; i++) {
			$scope.viewers[i].username = $scope.viewers[i].username.replace(/\W/g, '');
		}
	};
	
	$scope.sendTorrent = function() {
		var torrentReq = {};
		torrentReq['username'] = $rootScope.fields.username;
		torrentReq['session'] = $rootScope.sessionNumber;
		torrentReq['torrentLink'] = EncryptService.encrypt($scope.torrent.magnet);
		torrentReq['viewers'] = JSON.stringify($scope.viewers);
		$scope.viewers = [];
		$scope.torrent.magnet = "";
		$rootScope.socket.emit('torrent', torrentReq);
		$modalInstance.close(true);
	};
	
	$scope.upload = function() {
		$scope.uploadFile();
		$modalInstance.close(true);
	};
})
.controller('ProgressForm', function ($scope, $modalInstance) {
	$scope.ok = function () {
		$modalInstance.close();
	};
});