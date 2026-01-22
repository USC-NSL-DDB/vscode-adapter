import * as vscode from 'vscode';

class Logger {
    private logger: vscode.LogOutputChannel;

    constructor() {
        this.logger= vscode.window.createOutputChannel("DDB Extension", {
			log: true,
		});
    }

    public trace(message: string, ...args: any[]): void {
        this.logger.trace(message, ...args);
    }

    public debug(message: string, ...args: any[]): void {
        this.logger.debug(message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        this.logger.info(message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        this.logger.warn(message, ...args);
    }

    public error(message: string, ...args: any[]): void {
        this.logger.error(message, ...args);
    }
}

export const logger = new Logger();
