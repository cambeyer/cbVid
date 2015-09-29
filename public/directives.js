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
		replace: true,
		restrict: 'E',
		template: '' +
			'<form ng-submit="login()">' +
				'<table style="background-color: #4558A7; color: white; padding: 30px; padding-left: 100px; padding-right: 100px; border-radius: 10px; border: 1px solid white" cellpadding="20" cellspacing="0" border="0" align="center">' +
					'<tr>' +
						'<td colspan="2">' +
							'<h2>cbVid Sign Up/Login</h2>' +
							'<span ng-if="error" style="color: red"><br>Incorrect login credentials</span>' +
						'</td>' +
					'</tr>' +
					'<tr>' +
						'<td>Username:</td>' +
						'<td>' +
							'<input id="username" class="loginctrl" type="text" ng-change="resetControls(this)" ng-model="fields.username" ng-trim="false" maxlength="20">' +
						'</td>' +
					'</tr>' +
					'<tr>' +
						'<td>Password:</td>' +
						'<td>' +
							'<input id="password" class="loginctrl" type="password" maxlength="128" ng-model="fields.password">' +
						'</td>' +
					'</tr>' +
					'<tr ng-if="confirmPassword">' +
						'<td>Confirm:</td>' +
						'<td>' +
							'<input id="confirm" class="loginctrl" type="password" maxlength="128" ng-model="fields.passwordConfirm">' +
						'</td>' +
					'</tr>' +
					'<tr>' +
						'<td colspan="2">' +
							'<input ng-show="!loading" class="mySubmit" type="submit" value="">' +
							'<span ng-show="loading"><img src="loading.gif" style="max-width: 60px"></span>' +
						'</td>' +
					'</tr>' +
				'</table>' +
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
					if ($rootScope.fields.droppedFiles.length > 0) {
						go = confirm("This will overwrite your previously dropped files.");
					}
					//if the user accepted the overwrite or there was no conflict, parse the files and reflect it in the interface
					if (go) {
						$rootScope.$apply(function () {
							//clear the old files that had been dropped
							$rootScope.fields.droppedFiles = [];
							var dropped = e.originalEvent.dataTransfer.files; //no originalEvent if jQuery script is included after angular
							for (var i in dropped) {
								//if the file has a type or a size that isn't a multiple of 4096 or is larger than 4096*3, then it is a file and not a folder
								//we don't want to handle folders as that functionality is not available in any browsers outside of Chrome
								if (dropped[i].type || (dropped[i].size && (dropped[i].size % 4096 !== 0 || dropped[i].size / 4096 > 3))) {
									$rootScope.fields.droppedFiles.push(dropped[i]);
								}
							}
							if ($rootScope.fields.droppedFiles.length > 0) {
								//if we're not in the upload pane already then open it and overwrite the folder
								if ($rootScope.fields.upload == false) {
									$rootScope.fields.upload = true;
									if ($scope.path && $scope.path !== "") {
										$rootScope.fields.folderName = $scope.path.substring(0, $scope.path.length - 1);
									} else {
										$rootScope.fields.folderName = "/";
									}
								} else {
									//if the upload pane is already open and we drag-dropped onto no path, keep what was there... but if we dropped on a custom folder, take that instead
									if ($scope.path && $scope.path !== "") {
										$rootScope.fields.folderName = $scope.path.substring(0, $scope.path.length - 1);
									}
								}
							}
						});
					}
				}
			});
		}
	};
}).
directive('uploadForm', function ($rootScope) {
	//directive that controls the upload form
	return {
		scope: false,
		restrict: 'A',
		template: '' +
			'<table ng-style="{backgroundColor : (fields.loading && \'#FF9999\') || \'transparent\'}" style="width: 330px; padding: 15px; border: 1px solid #909090" cellpadding="10" cellspacing="0" border="0" align="center">' +
				'<tr>' +
					'<td valign="top">Folder:</td>' +
					'<td>' +
						'<span ng-bind="fields.folderName | humanreadable"></span>' +
						'<input type="text" ng-show="false" id="folder" ng-model="fields.folderName" name="folder">' +
					'</td>' +
				'</tr>' +
				'<tr>' +
					'<td valign="top">File(s):</td>' +
					'<td>' +
					//ng-show="!(fields.droppedFiles.length > 0) || this.value !== \'\'"
						'<input style="width: 100%" id="file" ng-disabled="fields.loading" type="file" name="{{activeClass}}"  ng-required="!(fields.droppedFiles.length > 0)" multiple="multiple">' +
						'<p><span ng-if="fields.droppedFiles.length > 0" style="color: red"><b>+</b></span></p>' +
						'<div style="width: 100%" ng-show="fields.droppedFiles.length"><span style="color: red"><b>{{fields.droppedFiles.length}} file(s) drag/dropped</b> <img style="float: right; max-height: 20px" ng-src="x.png" ng-click="fields.droppedFiles = []"></span></div>' +
					'</td>' +
				'</tr>' +
				'<tr>' +
					'<td valign="top" align="left" colspan="2">' +
						'<label><input ng-model="futureReveal" ng-disabled="fields.loading" type="checkbox"></input> Future Reveal</label><br />' +
						'<p>' +
							'<div ng-show="futureReveal"><span style="padding-right: 10px">Date: </span><input style="width: 170px" ng-required="futureReveal" ng-model="revealTime" id="datetimepicker" type="text" name="reveal"></input><script type="text/javascript">$("#datetimepicker").AnyTime_picker({' +
								'format: \'%m/%e/%Y %h:%i:%s %p\',' +
								'earliest: new Date(),' +
							'});</script></div>' +
						'</p>' +
					'</td>' +
				'</tr>' +
				'<tr>' +
					'<td colspan="2" align="center" style="padding-top: 20px">' +
						'<input style="width: 60%; height: 40px" type="submit" ng-disabled="fields.loading" value="Submit"></input>' +
					'</td>' +
				'</tr>' +
			'</table>',
		link: function ($scope, elem, attr) {
			//when the form is submitted, take over that event
			elem.bind('submit', function (e) {
				//$(elem).children('table').css('background-color', '#FF9999');
				e.preventDefault();
				$scope.$apply(function () {
					if ($scope.futureReveal) {
						$scope.revealTime = new Date($scope.revealTime).getTime();
					} else {
						$scope.revealTime = "";
					}
				});
				var oData = new FormData(this);
				$scope.$apply(function () {
					$scope.futureReveal = false;
				});
				$rootScope.$apply(function () {
					$rootScope.fields.loading = true; //must be applied after the form data is grabbed since disabling the file input keeps it from actually uploading
				});
				for (var i = 0; i < $rootScope.fields.droppedFiles.length; i++)
				{
					//loop through all of the dropped files and append them to the formdata
					oData.append($scope.activeClass, $rootScope.fields.droppedFiles[i]);
				}
				$rootScope.$apply(function () {
					//clear out the dropped files before uploading this batch so if the user drops more on, those can be queued up for the next round after this is finished
					$rootScope.fields.droppedFiles = [];
				});
				//we're sending the data to the server using XMLHttpRequest
				//uploading to the /upload endpoint
				var oReq = new XMLHttpRequest();
				oReq.open("post", "upload", true);
				oReq.onload = function (oEvent) {
					if (oReq.status == 200) {
						//$(elem).children('table').css('background-color', 'transparent');
						$rootScope.$apply(function () {
							$rootScope.fields.loading = false;
						});
						try {
							if ($rootScope.fields.droppedFiles.length == 0) {
								$rootScope.$apply(function () {
									$rootScope.fields.upload = false;
								});
							}
							document.getElementById('file').value = '';
							$scope.revealTime = "";
						} catch (e) {}
					} else {
						alert("There was an error uploading your file");
					}
				};
				//send the data
				oReq.send(oData);

			});
		}
	};
}).directive('progressBar', function ($document) {
	return {
		restrict: 'E',
		scope: {
            percent: '=',
            timestamp: '=',
            bartype: '@',
            file: '='
        },
		template: '' +
			'<p ng-if="file" ng-bind="file | limitTo: 50" style="white-space: nowrap"></p><p ng-if="!file"><b>Processing</b></p><div ng-if="percent" ng-style="{\'width\': width + \'px\'}" style="height: 100%; background-color: gray; float: left"><div ng-class="{\'uploading\': bartype == \'uploading\', \'processing\': bartype == \'processing\'}" ng-style="{\'width\': percent + \'%\'}" style="height: 100%; float: left">&nbsp</div></div><div style="float: right; width: 50px; text-align: right">{{percent}}%</div><div ng-if="!percent">Seconds processed: {{timestamp}}</div>',
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