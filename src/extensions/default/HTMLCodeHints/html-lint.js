/*
 * GNU AGPL-3.0 License
 *
 * Copyright (c) 2021 - present core.ai . All rights reserved.
 * Original work Copyright (c) 2012 - 2021 Adobe Systems Incorporated. All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see https://opensource.org/licenses/AGPL-3.0.
 *
 */

/* global path*/

/**
 * Provides JSLint results via the core linting extension point
 */
define(function (require, exports, module) {

    // Load dependent modules
    const CodeInspection   = brackets.getModule("language/CodeInspection"),
        AppInit            = brackets.getModule("utils/AppInit"),
        Strings            = brackets.getModule("strings"),
        StringUtils        = brackets.getModule("utils/StringUtils"),
        FileSystemError    = brackets.getModule("filesystem/FileSystemError"),
        DocumentManager    = brackets.getModule("document/DocumentManager"),
        EditorManager      = brackets.getModule("editor/EditorManager"),
        ProjectManager     = brackets.getModule("project/ProjectManager"),
        PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
        Metrics            = brackets.getModule("utils/Metrics"),
        FileSystem         = brackets.getModule("filesystem/FileSystem"),
        IndexingWorker     = brackets.getModule("worker/IndexingWorker");

    IndexingWorker.loadScriptInWorker(`${module.uri}/../worker/html-worker.js`);

    const prefs = PreferencesManager.getExtensionPrefs("HTMLLint");
    const PREFS_HTML_LINT_DISABLED = "disabled";
    const CONFIG_FILE_NAME = ".htmlvalidate.json";
    const UNSUPPORTED_CONFIG_FILES = [".htmlvalidate.js", ".htmlvalidate.cjs"];

    let projectSpecificOptions, configErrorMessage, configID = 0;

    prefs.definePreference(PREFS_HTML_LINT_DISABLED, "boolean", false, {
        description: Strings.DESCRIPTION_HTML_LINT_DISABLE
    }).on("change", function () {
        CodeInspection.requestRun(Strings.HTML_LINT_NAME);
    });

    function getTypeFromSeverity(sev) {
        // https://html-validate.org/guide/api/getting-started.html
        switch (sev) {
        case 1:  return CodeInspection.Type.WARNING;
        case 2:  return CodeInspection.Type.ERROR;
        default: return CodeInspection.Type.META;
        }
    }

    function _getLinterConfigFileErrorMsg() {
        return [{
            // JSLint returns 1-based line/col numbers
            pos: { line: -1, ch: 0 },
            message: configErrorMessage,
            type: CodeInspection.Type.ERROR
        }];
    }

    /**
     * Run JSLint on the current document. Reports results to the main UI. Displays
     * a gold star when no errors are found.
     */
    async function lintOneFile(text, fullPath) {
        return new Promise((resolve, reject)=>{
            if(configErrorMessage){
                resolve({ errors: _getLinterConfigFileErrorMsg() });
                return;
            }
            IndexingWorker.execPeer("htmlLint", {
                text,
                filePath: fullPath,
                configID,
                config: projectSpecificOptions
            }).then(lintResult =>{
                const editor = EditorManager.getCurrentFullEditor();
                if(!editor || editor.document.file.fullPath !== fullPath) {
                    reject(new Error("Lint failed as  "+ ProjectManager.getProjectRelativeOrDisplayPath(fullPath)
                        + " is not active."));
                    return;
                }
                if (lintResult && lintResult.length) {
                    lintResult = lintResult.map(function (lintError) {
                        return {
                            pos: editor.posFromIndex(lintError.start),
                            endPos: editor.posFromIndex(lintError.end),
                            message: `${lintError.message} (${lintError.ruleId})`,
                            type: getTypeFromSeverity(lintError.severity),
                            moreInfoURL: lintError.ruleUrl
                        };
                    });

                    resolve({ errors: lintResult });
                }
                resolve();
            });
        });
    }

    function _readConfig(dir) {
        return new Promise((resolve, reject)=>{
            const configFilePath = path.join(dir, CONFIG_FILE_NAME);
            let displayPath = ProjectManager.getProjectRelativeOrDisplayPath(configFilePath);
            DocumentManager.getDocumentForPath(configFilePath).done(function (configDoc) {
                let config;
                const content = configDoc.getText();
                try {
                    config = JSON.parse(content);
                    console.log("html-lint: loaded config file for project " + configFilePath);
                } catch (e) {
                    console.log("html-lint: error parsing " + configFilePath, content, e);
                    // just log and return as this is an expected failure for us while the user edits code
                    reject(StringUtils.format(Strings.HTML_LINT_CONFIG_JSON_ERROR, displayPath));
                    return;
                }
                resolve(config);
            }).fail((err)=>{
                if(err === FileSystemError.NOT_FOUND){
                    resolve(null); // no config file is a valid case. we just resolve with null
                    return;
                }
                console.error("Error reading JSHint Config File", configFilePath, err);
                reject("Error reading JSHint Config File", displayPath);
            });
        });
    }

    async function _validateUnsupportedConfig(scanningProjectPath) {
        let errorMessage;
        for(let unsupportedFileName of UNSUPPORTED_CONFIG_FILES) {
            let exists = await FileSystem.existsAsync(path.join(scanningProjectPath, unsupportedFileName));
            if(exists) {
                errorMessage = StringUtils.format(Strings.HTML_LINT_CONFIG_UNSUPPORTED, unsupportedFileName);
                break;
            }
        }
        if(scanningProjectPath !== ProjectManager.getProjectRoot().fullPath) {
            // this is a rare race condition where the user switches project between the config reload
            // Eg. in integ tests. do nothing as another scan for the new project will be in progress.
            return;
        }
        configErrorMessage = errorMessage;
        CodeInspection.requestRun(Strings.HTML_LINT_NAME);
    }

    function _reloadOptions() {
        projectSpecificOptions = null;
        configErrorMessage = null;
        const scanningProjectPath = ProjectManager.getProjectRoot().fullPath;
        configID++;
        _readConfig(scanningProjectPath, CONFIG_FILE_NAME).then((config)=>{
            configID++;
            if(scanningProjectPath !== ProjectManager.getProjectRoot().fullPath){
                // this is a rare race condition where the user switches project between the get document call.
                // Eg. in integ tests. do nothing as another scan for the new project will be in progress.
                return;
            }
            if(config) {
                Metrics.countEvent(Metrics.EVENT_TYPE.LINT, "html", "configPresent");
                projectSpecificOptions = config;
                configErrorMessage = null;
                CodeInspection.requestRun(Strings.HTML_LINT_NAME);
            } else {
                _validateUnsupportedConfig(scanningProjectPath)
                    .catch(console.error);
            }
        }).catch((err)=>{
            configID++;
            if(scanningProjectPath !== ProjectManager.getProjectRoot().fullPath){
                return;
            }
            Metrics.countEvent(Metrics.EVENT_TYPE.LINT, "HTMLConfig", "error");
            configErrorMessage = err;
            CodeInspection.requestRun(Strings.HTML_LINT_NAME);
        });
    }

    function _isFileInArray(pathToMatch, filePathArray){
        if(!filePathArray){
            return false;
        }
        for(let filePath of filePathArray){
            if(filePath === pathToMatch){
                return true;
            }
        }
        return false;
    }

    function _projectFileChanged(_evt, changedPath, added, removed) {
        let configFilePath = path.join(ProjectManager.getProjectRoot().fullPath, CONFIG_FILE_NAME);
        if(changedPath=== configFilePath
            || _isFileInArray(configFilePath, added) || _isFileInArray(configFilePath, removed)){
            _reloadOptions();
        }
    }

    AppInit.appReady(function () {
        ProjectManager.on(ProjectManager.EVENT_PROJECT_PATH_CHANGED_OR_RENAMED, _projectFileChanged);
        ProjectManager.on(ProjectManager.EVENT_PROJECT_OPEN, _reloadOptions);
        _reloadOptions();
    });

    CodeInspection.register("html", {
        name: Strings.HTML_LINT_NAME,
        scanFileAsync: lintOneFile,
        canInspect: function (_fullPath) {
            return !prefs.get(PREFS_HTML_LINT_DISABLED);
        }
    });
});
