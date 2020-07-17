// Support for make operations

import * as configuration from './configuration';
import * as ext from './extension';
import * as fs from 'fs';
import * as logger from './logger';
import * as util from './util';
import * as vscode from 'vscode';

export function prepareBuildCurrentTarget(): string[] {
    let makeArgs: string[] = [];
    // Prepend the target to the arguments given in the configurations json.
    let currentTarget: string | undefined = configuration.getCurrentTarget();
    if (currentTarget) {
        makeArgs.push(currentTarget);
    }

    makeArgs = makeArgs.concat(configuration.getConfigurationMakeArgs());

    logger.message("Building the current target. Command: " + configuration.getConfigurationMakeCommand() + " " + makeArgs.join(" "));
    return makeArgs;
}

export async function buildCurrentTarget(): Promise<void> {
    let makeArgs: string[] = prepareBuildCurrentTarget();
    try {
        // Append without end of line since there is one already included in the stdout/stderr fragments
        let stdout : any = (result: string): void => {
            logger.messageNoCR(result);
        };

        let stderr : any = (result: string): void => {
            logger.messageNoCR(result);
        };

        let closing : any = (retCode: number, signal: string): void => {
            if (retCode !== 0) {
                logger.message("The current target failed to build.");
            } else {
                logger.message("The current target built successfully.");
            }
        };

        await util.spawnChildProcess(configuration.getConfigurationMakeCommand(), makeArgs, vscode.workspace.rootPath || "", stdout, stderr, closing);
    } catch (error) {
        // No need for notification popup, since the build result is visible already in the output channel
        logger.message(error);
    }
}
export function parseBuild(): boolean {
    let buildLog : string | undefined = configuration.getConfigurationBuildLog();
    let buildLogContent: string | undefined = buildLog ? util.readFile(buildLog) : undefined;
    if (buildLogContent) {
        logger.message('Parsing the provided build log "' + buildLog + '" for IntelliSense integration with CppTools...');
        ext.updateProvider(buildLogContent);
        return true;
    }

    return false;
}

export async function parseBuildOrDryRun(): Promise<void> {
    // If a build log is specified in makefile.configurations or makefile.buildLog
    // (and if it exists on disk) it must be parsed instead of invoking a dry-run make command.
    // If a dry-run cache is present, we don't parse from it here. This operation is performed
    // when a project is loaded (we don't know how any setting or makefile have been changed
    // since the last open) and when the user executes the makefile.configure command
    // (which doesn't make sense to be run without some edits since the last configure).
    if (parseBuild()) {
        return;
    }

    let makeArgs: string[] = [];

    // Prepend the target to the arguments given in the configurations json.
    let currentTarget: string | undefined = configuration.getCurrentTarget();
    if (currentTarget) {
        makeArgs.push(currentTarget);
    }

    // Include all the make arguments defined in makefile.configurations.makeArgs
    makeArgs = makeArgs.concat(configuration.getConfigurationMakeArgs());

    // Append --dry-run switches
    makeArgs.push("--dry-run");
    const dryRunSwitches: string[] | undefined = configuration.getDryRunSwitches();
    if (dryRunSwitches) {
        makeArgs = makeArgs.concat(dryRunSwitches);
    }

    logger.message("Generating the make dry-run output for parsing IntelliSense information. Command: " +
        configuration.getConfigurationMakeCommand() + " " + makeArgs.join(" "));

    try {
        let stdoutStr: string = "";
        let stderrStr: string = "";

        let stdout : any = (result: string): void => {
            stdoutStr += result;
        };

        let stderr : any = (result: string): void => {
            stderrStr += result;
        };

        let closing : any = (retCode: number, signal: string): void => {
            let dryrunCache: string = configuration.getDryrunCache();
            if (retCode !== 0) {
                logger.message("The make dry-run command failed. IntelliSense may work only partially or not at all.");
                logger.message(stderrStr);
                util.reportDryRunError();
            }

            fs.writeFileSync(dryrunCache, stdoutStr);
            ext.updateProvider(stdoutStr);
        };

        await util.spawnChildProcess(configuration.getConfigurationMakeCommand(), makeArgs, vscode.workspace.rootPath || "", stdout, stderr, closing);
    } catch (error) {
        logger.message(error);
    }
}

export async function runPreconfigureScript(): Promise<void> {
    let script: string | undefined = configuration.getPreconfigureScript();
    if (!script || !util.checkFileExistsSync(script)) {
        vscode.window.showErrorMessage("Could not find pre-configure script.");
        logger.message("Make sure a pre-configuration script path is defined with makefile.preconfigureScript and that it exists on disk.");
        return;
    }

    let scriptArgs: string[] = [];
    let runCommand: string;
    if (process.platform === 'win32') {
        runCommand = "cmd";
        scriptArgs.push("/c");
        scriptArgs.push(script);
    } else {
        runCommand = "/bin/bash";
        scriptArgs.push("-c");
        scriptArgs.push(`"source ${script}"`);
    }

    try {
        let stdoutStr: string = "";
        let stderrStr: string = "";

        let stdout : any = (result: string): void => {
            stdoutStr += result;
        };

        let stderr : any = (result: string): void => {
            stderrStr += result;
        };

        let closing : any = (retCode: number, signal: string): void => {
            if (retCode === 0) {
                logger.message("The preconfigure script run successfully.");
            } else {
                logger.message("The preconfigure script failed. This project may not configure successfully.");
                logger.message(stderrStr);
            }
        };

        await util.spawnChildProcess(runCommand, scriptArgs, vscode.workspace.rootPath || "", stdout, stderr, closing);
    } catch (error) {
        logger.message(error);
    }
}
