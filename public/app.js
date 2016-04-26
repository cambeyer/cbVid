/*global angular*/
angular.module('cbVidApp', ['ngAnimate', 'ui.router', 'ngStorage', 'ui.bootstrap'])

.config(function($stateProvider, $urlRouterProvider) {
    $stateProvider
        .state('auth', {
            url: '/auth',
            templateUrl: 'auth.html',
            controller: 'authController'
        })

        .state('cbvid', {
            templateUrl: 'cbvid.html',
			controller: 'containerController'
        })

		.state('cbvid.list', {
			url: '/videos/:hash',
			templateUrl: 'list.html',
			controller: function ($stateParams, $rootScope) {
				$rootScope.playerReady = false;
				$rootScope.playerLoading = false;
				if (!$stateParams.hash) {
					$rootScope.activeVideo = undefined;
				} else if (!$rootScope.activeVideo || $rootScope.activeVideo.hash != $stateParams.hash) {
					$rootScope.playTorrent({ magnet: $stateParams.hash, hash: $stateParams.hash, title: "[Loading]" });
				}
			}
		});

    $urlRouterProvider.otherwise('/auth');
})

.run(function($rootScope, $localStorage, $state, EncryptService, UserObj) {
	$rootScope.$storage = $localStorage;
	$rootScope.$storage.authed;
	$rootScope.title;
	/*global io*/
	$rootScope.socket = io();
	$rootScope.pendingState;
	$rootScope.pendingParameters;
	$rootScope.search = {
		text: ''
	};
	
	$rootScope.activeVideo;
	$rootScope.player;
	$rootScope.playerReady = false;
	$rootScope.playerLoading = false;
	
	$rootScope.torrentList = [];
	$rootScope.staleQuery = "";
	$rootScope.isInMyView = false;

	$rootScope.setTitle = function(title) {
		$rootScope.title = title + " - cbVid";
	};
	
	$rootScope.playTorrent = function(torrent) {
		$rootScope.activeVideo = $.extend(true, {}, torrent);
		$rootScope.setTitle(torrent.title);
		$state.transitionTo("cbvid.list", { hash: torrent.hash }, { notify: false, reload: false });
		$rootScope.setVideo();
	};
	
	$rootScope.videoString = function (videoFile) {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			/*global btoa*/
			return "./" + $rootScope.$storage.username + "/" + $rootScope.$storage.sessionNumber + "/" + btoa(EncryptService.encrypt(videoFile)) + "/stream.m3u8";
		}
	};

	$rootScope.setVideo = function () {
		if (!$rootScope.playerReady && !$rootScope.playerLoading) {
			$rootScope.playerLoading = true;
			if ($rootScope.player) {
				$rootScope.player.dispose();
			}
			/*global videojs*/
			videojs("video", {
				plugins: {
					chromecast: {
						appId: "cbVid"
					}
				}
			}, function(){
				$rootScope.playerLoading = false;
				$rootScope.playerReady = true;
				$rootScope.player = this;
				$rootScope.player.on('loadedmetadata', function() {
					//$rootScope.player.controls(true);
					if ((!$rootScope.activeVideo.torrenting || $rootScope.activeVideo.remaining < 0) && !$rootScope.activeVideo.terminated) {
						$rootScope.player.play();
					}
				});
				/*
				$rootScope.player.on('timeupdate', function() {
					console.log($rootScope.player.currentTime());
				});
				*/
				$rootScope.setVideo();
			});
		} else {
			if ($rootScope.activeVideo.magnet) {
				//$rootScope.player.controls(false);
				$rootScope.player.src({"type": "application/x-mpegURL", "src": $rootScope.videoString($rootScope.activeVideo.magnet)});
			}
		}
		
	};

	$rootScope.socket.on('reconnect', function (num) {
		$rootScope.$apply(function () {
			$rootScope.verify();
		});
	});

	$rootScope.verify = function() {
		if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
			console.log("Verifying");
			$rootScope.socket.emit('verify', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('client') }));
		}
	};

	$rootScope.socket.on('verifyok', function(successBool) {
		$rootScope.$storage.authed = successBool !== 'false';
		if (!$rootScope.$storage.authed) {
			$localStorage.$reset({
				username: $rootScope.$storage.username
			});
			$rootScope.activeVideo = undefined;
			EncryptService.reset();
			$rootScope.torrentList = [];
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$state.reload();
		} else {
			if ($state.current.name == 'auth') {
				$state.go('cbvid.list');
			}
		}
	});

	$rootScope.$watch(function () {return $rootScope.$storage.sessionNumber}, function (newValue, oldValue) {
		if (newValue !== oldValue) {
			if (newValue && !oldValue) {
				$rootScope.verify();
			} else if (oldValue && !newValue) {
				$rootScope.activeVideo = undefined;
				EncryptService.reset();
				$rootScope.torrentList = [];
				$rootScope.search.text = '';
				$rootScope.staleQuery = '';
				$state.go('auth');
			}
		}
	});

	$rootScope.logout = function () {
		$rootScope.socket.emit('logout', UserObj.getUser({ verification: EncryptService.encrypt('logout') }));
	};

	$rootScope.socket.on('logout', function(msg) {
		if ($rootScope.$storage.username == msg.username && $rootScope.$storage.sessionNumber == msg.session) {
			$rootScope.search.text = '';
			$rootScope.staleQuery = '';
			$rootScope.activeVideo = undefined;
			$rootScope.torrentList = [];
			$localStorage.$reset();
			EncryptService.reset();
			$state.go('auth');
		}
	});

	$rootScope.socket.on('listtorrent', function (torrentList) {
		$rootScope.$apply(function() {
			$rootScope.torrentList = torrentList;
		});
	});
	
	$rootScope.socket.on('broadcast', function (broadcastMessage) {
		$rootScope.$apply(function() {
			if ($rootScope.isInMyView && broadcastMessage.username == $rootScope.$storage.username && broadcastMessage.sessionNumber == $rootScope.$storage.sessionNumber) {
				var item = JSON.parse(CryptoJS.AES.decrypt(broadcastMessage.message, $rootScope.$storage.secret).toString(CryptoJS.enc.Utf8));
				if (item.type == "add") {
					var found = false;
					for (var i = 0; i < $rootScope.torrentList.length; i++) {
						if ($rootScope.torrentList[i].hash == item.payload.hash) {
							found = true;
							break;
						}
					}
					if (!found) {
						$rootScope.torrentList.unshift(item.payload);
					}
				} else if (item.type == "remove") {
					for (var i = 0; i < $rootScope.torrentList.length; i++) {
						if ($rootScope.torrentList[i].hash == item.payload.hash) {
							$rootScope.torrentList.splice(i, 1);
							break;
						}
					}
				}
			}
		});
	});
	
	$rootScope.socket.on('status', function(statusUpdate) {
		$rootScope.$apply(function() {
			var extraTime = 0;
			if ($rootScope.activeVideo && $rootScope.activeVideo.hash == statusUpdate.hash) {
				for (var prop in statusUpdate) {
					if (prop != "_id" && prop != "timeStarted") {
						$rootScope.activeVideo[prop] = statusUpdate[prop];
					}
				}
				$rootScope.setTitle(statusUpdate.title);
				if ($rootScope.activeVideo.remaining && !statusUpdate.remaining) {
					delete $rootScope.activeVideo.remaining;
				}
				if (statusUpdate.remaining) {
					extraTime = $rootScope.player.currentTime() ? $rootScope.player.currentTime() : 0;
				} else if (statusUpdate.terminated) {
					alert("Sorry! Looks like we aren't able to stream that video.");
				}
				if (extraTime) {
					$rootScope.activeVideo.remaining += extraTime;
				}
			}
			for (var i = 0; i < $rootScope.torrentList.length; i++) {
				if ($rootScope.torrentList[i].hash == statusUpdate.hash) {
					for (var prop in statusUpdate) {
						if (prop != "_id" && prop != "timeStarted") {
							$rootScope.torrentList[i][prop] = statusUpdate[prop];
						}
					}
					if ($rootScope.torrentList[i].remaining && !statusUpdate.remaining) {
						delete $rootScope.torrentList[i].remaining;
					}
					if (extraTime) {
						$rootScope.torrentList[i].remaining += extraTime;
					}
				}
			}
		});
	});

	$rootScope.$on('$stateChangeStart', function(event, toState, toParams) {
		//console.log(fromState.name + " to " + toState.name);
		if (toState.name !== 'auth') {
			if (!$rootScope.$storage.authed) {
				$rootScope.pendingState = String(toState.name);
				$rootScope.pendingParameters = JSON.parse(angular.toJson(toParams));
				event.preventDefault();
				$state.go('auth');
				return;
			}
			if ($rootScope.pendingState) {
				event.preventDefault();
				var newDest = String($rootScope.pendingState);
				var newParams = JSON.parse(angular.toJson($rootScope.pendingParameters));
				$rootScope.pendingState = undefined;
				$rootScope.pendingParameters = undefined;
				$state.go(newDest, newParams);
			}
		}
	});
})

.controller('authController', function($scope, $rootScope) {
	$rootScope.setTitle("Login");
	$scope.loading = false;
	$scope.confirmPassword = false;
	$rootScope.srpClient;

	$rootScope.credentials = {
		password: "",
		passwordConfirm: ""
	};

	$scope.srpObj;

	if ($rootScope.$storage.username && $rootScope.$storage.sessionNumber) {
		$rootScope.verify();
	}

	$('#username').focus();
	if ($rootScope.$storage.username) {
		$('#password').focus();
	}

	$scope.login = function () {
		if ($rootScope.$storage.username && $rootScope.credentials.password) {
			$rootScope.$storage.authed = false;
			$scope.loading = true;
			delete $rootScope.$storage.sessionNumber;
			if (!$scope.confirmPassword) {
				/*global jsrp*/
				$rootScope.srpClient = new jsrp.client();
				$rootScope.srpClient.init({ username: $rootScope.$storage.username, password: CryptoJS.MD5($rootScope.credentials.password).toString() }, function () {
					$scope.srpObj = {};
					$scope.srpObj.username = $rootScope.$storage.username;
					$scope.srpObj.publicKey = $rootScope.srpClient.getPublicKey();
					$rootScope.socket.emit('login', $scope.srpObj);
				});
			} else {
				if ($rootScope.credentials.passwordConfirm == $rootScope.credentials.password) {
					if ($rootScope.$storage.username.indexOf('@') < 1) {
						alert("Please use a valid e-mail address.");
						$scope.loading = false;
					} else {
						$rootScope.srpClient.createVerifier(function (err, result) {
							if (!err) {
								$scope.srpObj.salt = result.salt;
								$scope.srpObj.verifier = result.verifier;
								$rootScope.socket.emit('new', $scope.srpObj);
							} else {
								console.log("Error creating verifier.");
							}
					    });
					}
				} else {
					alert("Your passwords do not match.  Please try again.");
					$rootScope.credentials.passwordConfirm = "";
					$rootScope.credentials.password = "";
					$("#password").focus();
				}
			}
		}
	};

	$rootScope.socket.on('new', function () {
		$scope.$apply(function () {
			$scope.loading = false;
			$scope.confirmPassword = true;
		});
		$('#confirm').focus();
	});

	$rootScope.socket.on('login', function (srpResponse) {
		$scope.$apply(function () {
			$rootScope.srpClient.setSalt(srpResponse.salt);
			$rootScope.srpClient.setServerPublicKey(srpResponse.publicKey);
			$rootScope.$storage.secret = $rootScope.srpClient.getSharedKey();
			try {
				$rootScope.$storage.sessionNumber = CryptoJS.AES.decrypt(srpResponse.encryptedPhrase, $rootScope.$storage.secret).toString(CryptoJS.enc.Utf8);
			} catch (e) { }
			var successBool = (!isNaN($rootScope.$storage.sessionNumber) && $rootScope.$storage.sessionNumber > 0);
			$scope.loading = false;
			if (!successBool) {
				$scope.error = true;
				$rootScope.credentials.password = "";
			} else {
				$scope.error = false;
			}
		});
	});

	$scope.resetControls = function () {
		$scope.confirmPassword = false;
		$rootScope.credentials.passwordConfirm = "";
		$rootScope.$storage.username = $rootScope.$storage.username.replace(/[^\w\.@-]/g, '');
		$rootScope.$storage.username = $rootScope.$storage.username.toLowerCase();
	};
})

.controller('containerController', function($scope, $rootScope, $timeout, EncryptService, UserObj) {
	var timer;
	
	if ($rootScope.activeVideo) {
		$rootScope.setTitle($rootScope.activeVideo.title);
	} else {
		$rootScope.setTitle("Welcome");
	}

	$scope.requestMyView = function() {
		$rootScope.isInMyView = true;
		$rootScope.search.text = "";
		$rootScope.staleQuery = "";
		$rootScope.torrentList = [];
		$rootScope.socket.emit('myview', UserObj.getUser({ encryptedPhrase: EncryptService.encrypt('myview') }));
	};
	
	$scope.requestMyView();
	
	$scope.removeTorrent = function(torrent) {
		if (confirm("Are you sure you want to remove this torrent from the list?")) {
			$rootScope.socket.emit('remove', UserObj.getUser({ hash: torrent.hash, encryptedPhrase: EncryptService.encrypt('remove') }));
		}
	};

	$scope.searchtor = function() {
		if ($rootScope.search.text) {
			$rootScope.isInMyView = false;
		} else {
			$scope.requestMyView();
		}
		$timeout.cancel(timer);
		if ($rootScope.staleQuery !== $rootScope.search.text) {
			$rootScope.torrentList = [];
		}
		timer = $timeout(function() {
			if (!$rootScope.staleQuery || $rootScope.staleQuery !== $rootScope.search.text) {
				$rootScope.socket.emit('listtorrent', UserObj.getUser({ query: $rootScope.search.text, encryptedPhrase: EncryptService.encrypt('listtorrent') }));
				$rootScope.staleQuery = $rootScope.search.text;
			}
		}, 2000);
	};
})

.service('EncryptService', function ($rootScope) {
    this.encryptedPhrases;
    this.reset = function() {
    	this.encryptedPhrases = {};
    };
    this.reset();
	this.encrypt = function (text) {
		if (!this.encryptedPhrases[text]) {
		    /*global CryptoJS*/
			this.encryptedPhrases[text] = CryptoJS.AES.encrypt(text, $rootScope.$storage.secret).toString();
		}
		return this.encryptedPhrases[text];
	};
})

.service('UserObj', function ($rootScope) {
	this.getUser = function (extraProps) {
		var loginObj = {};
		loginObj.username = $rootScope.$storage.username;
		loginObj.session = $rootScope.$storage.sessionNumber;
		$.extend(loginObj, extraProps);
		return loginObj;
	};
})

.filter('secondsToDateTime', [function() {
    return function(seconds) {
        return new Date(1970, 0, 1).setSeconds(seconds);
    };
}])

.filter('isEmpty', function () {
	return function (obj) {
		for (var bar in obj) {
			if (obj.hasOwnProperty(bar)) {
				return false;
			}
		}
		return true;
	};
})

.filter('greenVideo', function () {
	return function (torrent) {
		if (torrent.torrenting == false && !torrent.terminated) {
			return true;
		} else if (torrent.remaining <= 0 && !torrent.terminated) {
			return true;
		} else {
			return false;
		}
	};
});