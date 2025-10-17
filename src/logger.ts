enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

class Logger {
    private static instance: Logger;
    private currentLevel: LogLevel = LogLevel.INFO;

    private constructor() {}

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    setLevel(level: LogLevel): void {
        this.currentLevel = level;
    }

    getCurrentLevel(): LogLevel {
        return this.currentLevel;
    }

    private log(level: LogLevel, component: string, message: string, ...args: unknown[]): void {
        if (level >= this.currentLevel) {
            const levelStr = LogLevel[level];
            const prefix = `[${levelStr}] [${component}]`;
            
            switch (level) {
                case LogLevel.DEBUG:
                    console.debug(prefix, message, ...args);
                    break;
                case LogLevel.INFO:
                    console.log(prefix, message, ...args);
                    break;
                case LogLevel.WARN:
                    console.warn(prefix, message, ...args);
                    break;
                case LogLevel.ERROR:
                    console.error(prefix, message, ...args);
                    break;
            }
        }
    }

    debug(component: string, message: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, component, message, ...args);
    }

    info(component: string, message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, component, message, ...args);
    }

    warn(component: string, message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARN, component, message, ...args);
    }

    error(component: string, message: string, ...args: unknown[]): void {
        this.log(LogLevel.ERROR, component, message, ...args);
    }
}

// Export both the singleton instance, class, and the LogLevel enum
const logger = Logger.getInstance();

export { logger, Logger, LogLevel };