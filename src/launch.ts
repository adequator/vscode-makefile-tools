// Launch support: debug and run in terminal

import * as configuration from './configuration';
import * as extension from './extension';
import * as logger from './logger';
import * as path from 'path';
import * as util from './util';
import * as vscode from 'vscode';

let launcher: Launcher;

export class Launcher implements vscode.Disposable {
    // Command property accessible from launch.json:
    // the full path of the target binary currently set for launch
    public launchTargetPath(): string {
        let launchConfiguration: configuration.LaunchConfiguration | undefined = configuration.getCurrentLaunchConfiguration();
        if (launchConfiguration) {
            return launchConfiguration.binary;
        } else {
            return "";
        }
    }

    // Command property accessible from launch.json:
    // the full path from where the target binary is to be launched
    public launchCurrentDir(): string {
        let launchConfiguration: configuration.LaunchConfiguration | undefined = configuration.getCurrentLaunchConfiguration();
        if (launchConfiguration) {
            return launchConfiguration.cwd;
        } else {
            return vscode.workspace.rootPath || "";
        }
    }

    // Command property accessible from launch.json:
    // the arguments sent to the target binary, returned as array of string
    // This is used by the debug/terminal VS Code APIs.
    public launchTargetArgs(): string[] {
        let launchConfiguration: configuration.LaunchConfiguration | undefined = configuration.getCurrentLaunchConfiguration();
        if (launchConfiguration) {
            return launchConfiguration.args;
        } else {
            return [];
        }
    }

    // Command property accessible from launch.json:
    // the arguments sent to the target binary, returned as one simple string
    // This is an alternative to define the arguments in launch.json,
    // since the string array syntax is not working.
    // This is not a perfect solution, it all depends on how the main entry point
    // is parsing its given arguments.
    // Example: for [CWD>tool arg1 arg2 arg3], the tool will receive
    // 2 arguments: tool and "arg1 arg2 arg3"
    // As opposed to the above case when the tool will receive
    // 4 arguments: tool, arg1, arg2, arg3
    // TODO: investigate how we can define string array arguments
    // for the target binary in launch.json
    public launchTargetArgsConcat(): string {
        return this.launchTargetArgs().join(" ");
    }

    // Invoke a VS Code debugging session passing it all the information
    // from the current launch configuration.
    // Debugger (imperfect) guess logic:
    //    - VS for msvc toolset, lldb for clang toolset, gdb for anything else.
    //    - debugger path is assumed to be the same as the compiler path.
    // Exceptions for miMode:
    //    - if the above logic results in a debugger that is missing, try the other one.
    //      This is needed either because the system might not be equipped
    //      with the preffered debugger that corresponds to the toolset in use,
    //      but also because there might be a compiler alias that is not properly identified
    //      (example: "cc" alias that points to clang but is not identified as clang,
    //       therefore requesting a gdb debugger which may be missing
    //       because there is no gcc toolset installed).
    //       TODO: implement proper detection of aliases and their commands.
    // Exceptions for miDebuggerPath:
    //    - intentionally do not provide a miDebuggerPath On MAC, because the debugger knows how to find automatically
    // the right lldb-mi when miMode is lldb and miDebuggerPath is undefined.
    // Additionally, cppvsdbg ignores miMode and miDebuggerPath.
    public async debugCurrentTarget(): Promise<vscode.DebugSession | undefined> {
        if (!configuration.getCurrentLaunchConfiguration()) {
            vscode.window.showErrorMessage("Currently there is no launch configuration set.");
            logger.message("Cannot start debugging because there is no launch configuration set. " +
                "Define one in the settings file or use the Makefile.setLaunchConfigurationCommand");
            return;
        }

        let args: string[] = this.launchTargetArgs();

        let compilerPath : string | undefined = extension.extension?.getCompilerFullPath();
        let parsedObjPath : path.ParsedPath | undefined = compilerPath ? path.parse(compilerPath) : undefined;
        let isClangCompiler : boolean | undefined = parsedObjPath?.name.startsWith("clang");
        let isMsvcCompiler : boolean | undefined = !isClangCompiler && parsedObjPath?.name.startsWith("cl");
        let dbg: string = (isMsvcCompiler) ? "cppvsdbg" : "cppdbg";
        let miDebuggerPath : string | undefined = (!isMsvcCompiler && parsedObjPath) ? parsedObjPath.dir : undefined;

        // Initial debugger guess
        let miMode: string | undefined;
        if (parsedObjPath?.name.startsWith("clang")) {
            miMode = "lldb";
        } else if (!parsedObjPath?.name.startsWith("cl")) {
            miMode = "gdb";
        }

        // If the first chosen debugger is not installed, try the other one.
        if (miDebuggerPath && miMode) {
            let debuggerPath: string = path.join(miDebuggerPath, miMode);
            if (process.platform === "win32") {
                // On mingw a file is not found if the extension is not part of the path
                debuggerPath = debuggerPath + ".exe";
            }

            if (!util.checkFileExistsSync(debuggerPath)) {
                miMode = (miMode === "gdb") ? "lldb" : "gdb";
            }
        }

        // Exception for MAC-lldb, intentionally don't provide the debugger path,
        // to allow the debugger extension to find it automatically
        if (miMode === "lldb" && process.platform === "darwin") {
            miDebuggerPath = undefined;
        } else if (miDebuggerPath && miMode) {
            miDebuggerPath = path.join(miDebuggerPath, miMode);
            if (process.platform === "win32") {
                miDebuggerPath = miDebuggerPath + ".exe";
            }
        }

        let debugConfig: vscode.DebugConfiguration;
        debugConfig = {
            type: dbg,
            name: `Debug My Program`,
            request: 'launch',
            cwd: '${command:Makefile.launchCurrentDir}',
            args,
            program: '${command:Makefile.launchTargetPath}',
            miMode: miMode,
            miDebuggerPath: miDebuggerPath
        };

        let startFolder : vscode.WorkspaceFolder;
        if (vscode.workspace.workspaceFolders) {
            startFolder = vscode.workspace.workspaceFolders[0];
            await vscode.debug.startDebugging(startFolder, debugConfig);
        } else {
            await vscode.debug.startDebugging(undefined, debugConfig);
        }

        return vscode.debug.activeDebugSession;
    }

    private launchTerminal: vscode.Terminal | undefined;

    // Watch for the user closing our terminal
    private readonly onTerminalClose = vscode.window.onDidCloseTerminal(term => {
        if (term === this.launchTerminal) {
            this.launchTerminal = undefined;
        }
    });

    // Invoke a VS Code running terminal passing it all the information
    // from the current launch configuration
    public async runCurrentTarget(): Promise<vscode.Terminal> {
        const terminalOptions: vscode.TerminalOptions = {
            name: 'Make/Launch',
        };

        // Use cmd.exe on Windows
        if (process.platform === 'win32') {
            terminalOptions.shellPath = 'C:\\Windows\\System32\\cmd.exe';
            terminalOptions.cwd = this.launchCurrentDir();
        }

        if (!this.launchTerminal) {
            this.launchTerminal = vscode.window.createTerminal(terminalOptions);
        }

        if (!configuration.getCurrentLaunchConfiguration()) {
            vscode.window.showErrorMessage("Currently there is no launch configuration set.");
            logger.message("Cannot start debugging because there is no launch configuration set. " +
                "Define one in the settings file or use the Makefile.setLaunchConfigurationCommand");

            return this.launchTerminal;
        }

        // Add a pair of quotes just in case there is a space in the binary path
        let terminalCommand: string = '"' + this.launchTargetPath() + '" ';
        terminalCommand += this.launchTargetArgs().join(" ");
        this.launchTerminal.sendText(terminalCommand);
        this.launchTerminal.show();
        return this.launchTerminal;
    }

    public dispose(): void {
        if (this.launchTerminal) {
            this.launchTerminal.dispose();
        }

        this.onTerminalClose.dispose();
    }
}

export function getLauncher(): Launcher {
    if (launcher === undefined) {
        launcher = new Launcher();
    }

    return launcher;
}
