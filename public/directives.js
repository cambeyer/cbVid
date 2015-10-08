//all of the user-defined Angular directives
/*global angular*/
angular.module('cbVidApp.directives', [])
.directive('videoplayer', function($parse) {
    return {
        restrict: 'A',
        link: function($scope, element, attrs, controller) {
            attrs.$observe('specialsrc', function() {
            	if ($scope.videoString($scope.activeVideo)) {
            		alert("hello");
            		element.attr('src', $scope.videoString($scope.activeVideo));
            	}
            });
        }
    };
})
.directive('loginform', function () {
	return {
		scope: false,
		replace: false,
		restrict: 'A',
		template: '' +
			'<form ng-submit="login()">' +
				'<div class="container" style="text-align: center; max-width: 450px; background-color: 9D9D9D; padding: 50px; border-radius: 20px; border: 1px solid black">' +
					'<div class="row">' +
						'<img src="logo.png" style="max-height: 60px; margin-bottom: 20px">' +
					'</div>' +
					'<div class="row">' +
						'<div ng-if="error" style="color: red; margin-bottom: 20px"><br>Incorrect login credentials</div>' +
					'</div>' +
					'<div class="row">' +
						'<div class="form-group">' +
							'<label for="username">Username:</label>' +
							'<input type="text" class="form-control" id="username" ng-change="resetControls(this)" ng-model="$storage.username" ng-trim="false" maxlength="20" placeholder="Username">' +
						'</div>' +
					'</div>' +
					'<div class="row">' +
						'<div class="form-group">' +
							'<label for="password">Password:</label>' +
							'<input type="password" class="form-control" id="password" ng-model="fields.password" maxlength="128" placeholder="Password">' +
						'</div>' +
					'</div>' +
					'<div class="row" ng-if="confirmPassword">' +
						'<div class="form-group">' +
							'<label for="confirm">Confirm:</label>' +
							'<input type="password" class="form-control" id="confirm" ng-model="fields.passwordConfirm" maxlength="128" placeholder="Confirm Password">' +
						'</div>' +
					'</div>' +
					'<div class="row" style="margin-top: 20px">' +
						'<input ng-if="!loading" class="mySubmit" type="submit" value="">' +
						'<span ng-show="loading"><img src="loading.gif" style="max-width: 60px"></span>' +
					'</div>' +
				'</div>' +
			'</form>',
		controller: function ($scope) {
		}
	};
}).
directive('dragAndDrop', function ($rootScope) {
	//directive for dragging and dropping onto a container
	return {
		scope: false,
		restrict: 'A',
		link: function ($scope, elem, attr) {
			//bind to dragenter to apply green highlighting to folder titles
			elem.bind('dragenter', function (e) {
				//don't let this event pass on to the default handlers
				e.stopPropagation();
				e.preventDefault();
				if ($scope.path && !$scope.student) {
					elem.filter('.titlebar').css('background-color', '#66C166');
				}
			});
			//bind to dragleave to remove green highlighting on folder titles
			elem.bind('dragleave', function (e) {
				//don't let this event pass on to the default handlers
				e.stopPropagation();
				e.preventDefault();
				if ($scope.path && !$scope.student) {
					elem.filter('.titlebar').css('background-color', '#F1F1F1');
				}
			});
			//bind to dragover to provide a secondary mechanism for applying green highlighting on folder titles
			elem.bind('dragover', function (e) {
				//don't let this event pass on to the default handlers
				e.stopPropagation();
				e.preventDefault();
				if ($scope.path && !$scope.student) {
					elem.filter('.titlebar').css('background-color', '#66C166');
				}
			});

			//auxiliary function to dynamically create a move link and click it for when a drag-drop action occurs
			var moveFile = function (elem, source) {
				var hash = source.split("/")[source.split("/").length - 1];
				var destination;
				if ($scope.path && $scope.path !== "") {
					if (!hash) {
						destination = $scope.path + source.split("/")[source.split("/").length - 2]	+ "/";
					} else {
						destination = $scope.path + hash;
					}
				} else {
					if (!hash) {
						destination = source.split("/")[source.split("/").length - 2] + "/";
					} else {
						destination = hash;
					}
				}
				if (destination.substring(0, source.length) !== source) {
					var link = document.createElement('a');
					link.href = "move?active=" + angular.element($(elem)).scope().activeClass + "&source=" + source + "&destination=" + destination;
					document.body.appendChild(link); //must be in DOM to work in Firefox
					link.target = "hidden-iframe";
					link.click();
					document.body.removeChild(link);
				}
			};

			//bind to the drop action
			elem.bind('drop', function (e) {
				//don't let this event pass on to the default handlers
				e.stopPropagation();
				e.preventDefault();
				if ($scope.path) {
					elem.filter('.titlebar').css('background-color', '#F1F1F1');
				}
				//check to make sure we're not in student mode
				if (!$scope.student) {
					var go = true;
					//if there is text data associated with the drop event, then interpret as a move and return
					if (e.originalEvent.dataTransfer.getData("text") && e.originalEvent.dataTransfer.getData("text") !== undefined) {
						moveFile(elem, e.originalEvent.dataTransfer.getData("text"));
						return;
					}
					//if there are already files that have been dropped onto the interface, then alert the user they will be overwritten
					if ($rootScope.$storage.droppedFiles.length > 0) {
						go = confirm("This will overwrite your previously dropped files.");
					}
					//if the user accepted the overwrite or there was no conflict, parse the files and reflect it in the interface
					if (go) {
						$rootScope.$apply(function () {
							//clear the old files that had been dropped
							$rootScope.$storage.droppedFiles = [];
							var dropped = e.originalEvent.dataTransfer.files; //no originalEvent if jQuery script is included after angular
							for (var i in dropped) {
								//if the file has a type or a size that isn't a multiple of 4096 or is larger than 4096*3, then it is a file and not a folder
								//we don't want to handle folders as that functionality is not available in any browsers outside of Chrome
								if (dropped[i].type || (dropped[i].size && (dropped[i].size % 4096 !== 0 || dropped[i].size / 4096 > 3))) {
									$rootScope.$storage.droppedFiles.push(dropped[i]);
								}
							}
							if ($rootScope.$storage.droppedFiles.length > 0) {
								//if we're not in the upload pane already then open it and overwrite the folder
								if ($rootScope.$storage.upload == false) {
									$rootScope.$storage.upload = true;
									if ($scope.path && $scope.path !== "") {
										$rootScope.$storage.folderName = $scope.path.substring(0, $scope.path.length - 1);
									} else {
										$rootScope.$storage.folderName = "/";
									}
								} else {
									//if the upload pane is already open and we drag-dropped onto no path, keep what was there... but if we dropped on a custom folder, take that instead
									if ($scope.path && $scope.path !== "") {
										$rootScope.$storage.folderName = $scope.path.substring(0, $scope.path.length - 1);
									}
								}
							}
						});
					}
				}
			});
		}
	};
})
.directive('progressBar', function ($document) {
	return {
		restrict: 'E',
		scope: {
            percent: '=',
            timestamp: '=',
            bartype: '@',
            file: '='
        },
		template: '' +
			'<p ng-bind="file | limitTo: 50" style="white-space: nowrap"></p><div ng-if="percent" ng-style="{\'width\': width + \'px\'}" style="height: 100%; background-color: gray; float: left"><div ng-class="{\'uploading\': bartype == \'uploading\', \'processing\': bartype == \'processing\'}" ng-style="{\'width\': percent + \'%\'}" style="height: 100%; float: left">&nbsp</div></div><div ng-if="percent" style="float: right; width: 50px; text-align: right">{{percent}}%</div><div ng-if="!percent && timestamp">Time processed: {{timestamp}}</div>',
		link: function (scope, element, attrs) {
			scope.width = element.parent()[0].offsetWidth - 50;
		}
	};
}).filter('isEmpty', function () {
	return function (obj) {
		for (var bar in obj) {
			if (obj.hasOwnProperty(bar)) {
				return false;
			}
		}
		return true;
	};
});