/**
 * Tests for Logger utility
 * Uses COMPLETELY MOCKED console - NO ACTUAL CONSOLE OUTPUT
 * Run with: npm test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { logger, Logger, LogLevel } from '../src/logger';

describe('Logger', () => {
    let originalConsole: Console;
    let mockConsole: any;

    beforeEach(() => {
        // Save original console and create mock
        originalConsole = global.console;
        mockConsole = {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };
        global.console = mockConsole as Console;
        
        // Reset logger to default level
        logger.setLevel(LogLevel.INFO);
    });

    afterEach(() => {
        // Restore original console
        global.console = originalConsole;
        vi.clearAllMocks();
    });

    describe('Log level management', () => {
        it('sets and gets log level correctly', () => {
            logger.setLevel(LogLevel.WARN);
            expect(logger.getCurrentLevel()).toBe(LogLevel.WARN);
            
            logger.setLevel(LogLevel.DEBUG);
            expect(logger.getCurrentLevel()).toBe(LogLevel.DEBUG);
        });

        it('has default log level of INFO', () => {
            logger.setLevel(LogLevel.INFO);
            expect(logger.getCurrentLevel()).toBe(LogLevel.INFO);
        });
    });

    describe('Log level filtering', () => {
        it.each([
            // [level, method, consoleFn, shouldLog]
            [LogLevel.DEBUG, 'debug', 'debug', true],
            [LogLevel.INFO, 'debug', 'debug', false],
            [LogLevel.WARN, 'debug', 'debug', false],
            [LogLevel.ERROR, 'debug', 'debug', false],
            
            [LogLevel.DEBUG, 'info', 'log', true],
            [LogLevel.INFO, 'info', 'log', true],
            [LogLevel.WARN, 'info', 'log', false],
            [LogLevel.ERROR, 'info', 'log', false],
            
            [LogLevel.DEBUG, 'warn', 'warn', true],
            [LogLevel.INFO, 'warn', 'warn', true],
            [LogLevel.WARN, 'warn', 'warn', true],
            [LogLevel.ERROR, 'warn', 'warn', false],
            
            [LogLevel.DEBUG, 'error', 'error', true],
            [LogLevel.INFO, 'error', 'error', true],
            [LogLevel.WARN, 'error', 'error', true],
            [LogLevel.ERROR, 'error', 'error', true],
        ])('at level %s, %s() should %s log', (level, method, consoleFn, shouldLog) => {
            logger.setLevel(level);
            
            (logger as any)[method]('TestComponent', 'Test message');
            
            if (shouldLog) {
                expect(mockConsole[consoleFn]).toHaveBeenCalledWith(
                    `[${method.toUpperCase()}] [TestComponent]`,
                    'Test message'
                );
            } else {
                expect(mockConsole[consoleFn]).not.toHaveBeenCalled();
            }
        });

        it('handles invalid log level gracefully', () => {
            expect(() => {
                logger.setLevel(999 as LogLevel);
            }).not.toThrow();
            
            // With invalid level (999), no logging should occur
            logger.error('Test', 'Error after invalid level');
            expect(mockConsole.error).not.toHaveBeenCalled();
        });
    });

    describe('Message formatting', () => {
        beforeEach(() => {
            logger.setLevel(LogLevel.DEBUG);
        });

        it('formats component names correctly', () => {
            logger.info('DatabaseService', 'Test message');
            
            expect(mockConsole.log).toHaveBeenCalledWith(
                '[INFO] [DatabaseService]',
                'Test message'
            );
        });

        it('handles multiline messages', () => {
            const multilineMessage = 'Line 1\nLine 2\nLine 3';
            logger.info('TestComponent', multilineMessage);
            
            expect(mockConsole.log).toHaveBeenCalledWith(
                '[INFO] [TestComponent]',
                'Line 1\nLine 2\nLine 3'
            );
        });

        it('handles special characters in messages', () => {
            const specialMessage = 'Message with émojis 🚀 and symbols @#$%';
            logger.info('TestComponent', specialMessage);
            
            expect(mockConsole.log).toHaveBeenCalledWith(
                '[INFO] [TestComponent]',
                'Message with émojis 🚀 and symbols @#$%'
            );
        });
    });

    describe('Extra data handling', () => {
        beforeEach(() => {
            logger.setLevel(LogLevel.DEBUG);
        });

        it('handles object extra data', () => {
            const extraData = { key: 'value', number: 42, nested: { prop: 'nested value' } };
            
            logger.info('TestComponent', 'Message with object', extraData);
            
            expect(mockConsole.log).toHaveBeenCalledWith(
                '[INFO] [TestComponent]',
                'Message with object',
                extraData
            );
        });

        it('handles array extra data', () => {
            const extraData = [1, 2, 3, 'four', { five: 5 }];
            
            logger.info('TestComponent', 'Message with array', extraData);
            
            expect(mockConsole.log).toHaveBeenCalledWith(
                '[INFO] [TestComponent]',
                'Message with array',
                extraData
            );
        });

        it('handles Error objects as extra data', () => {
            const testError = new Error('Test error details');
            
            logger.error('TestComponent', 'Error occurred', testError);
            
            expect(mockConsole.error).toHaveBeenCalledWith(
                '[ERROR] [TestComponent]',
                'Error occurred',
                testError
            );
        });
    });

    describe('Real-world scenarios', () => {
        it('handles typical plugin logging flow', () => {
            logger.setLevel(LogLevel.INFO);
            
            // Startup
            logger.info('Plugin', 'Loading Tezcat plugin');
            
            // Configuration (should be filtered out)
            logger.debug('Settings', 'Loaded settings', { chunkSize: 128, provider: 'ollama' });
            
            // Operations
            logger.info('DatabaseService', 'Processing 150 files');
            logger.warn('EmbeddingService', 'Retry attempt 2/3 for embedding generation');
            
            // Errors
            logger.error('SearchService', 'Failed to search similar content', new Error('Database connection lost'));
            
            expect(mockConsole.log).toHaveBeenCalledTimes(2); // info calls
            expect(mockConsole.debug).not.toHaveBeenCalled(); // filtered out
            expect(mockConsole.warn).toHaveBeenCalledTimes(1);
            expect(mockConsole.error).toHaveBeenCalledTimes(1);
        });
    });
});