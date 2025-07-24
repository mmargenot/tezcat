import { Notice } from 'obsidian';
import { Logger } from './logger';
import { EmbeddingProvider, OllamaModelManager, OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from './embedding_service';
import { SqlJsDatabaseAdapter, DatabaseService } from './database_service';

export interface ValidationResult {
    success: boolean;
    message: string;
    error?: Error;
}

export interface SystemValidationResult {
    embeddingProvider: ValidationResult;
    database: ValidationResult;
    models: ValidationResult;
    overall: ValidationResult;
}

export class ValidationService {
    private logger: Logger;
    private modelManager: OllamaModelManager | null = null;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * Set the model manager for Ollama-specific validation
     */
    setModelManager(modelManager: OllamaModelManager): void {
        this.modelManager = modelManager;
    }

    /**
     * Validate embedding provider connectivity and configuration
     */
    async validateEmbeddingProvider(provider: EmbeddingProvider): Promise<ValidationResult> {
        try {
            this.logger.info('ValidationService', 'Validating embedding provider...');
            
            // Use the provider's built-in validation
            await provider.validate();
            
            this.logger.info('ValidationService', 'Embedding provider validation successful');
            return {
                success: true,
                message: 'Embedding provider is accessible and configured correctly'
            };
            
        } catch (error) {
            this.logger.error('ValidationService', 'Embedding provider validation failed', error);
            
            let message = 'Embedding provider validation failed';
            if (error instanceof Error) {
                message = error.message;
            }
            
            return {
                success: false,
                message,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Validate and ensure required models are available (Ollama only)
     */
    async validateModels(provider: EmbeddingProvider, modelNames: string[]): Promise<ValidationResult> {
        try {
            // Only validate models for Ollama provider
            if (!(provider instanceof OllamaEmbeddingProvider)) {
                return {
                    success: true,
                    message: 'Model validation not required for this provider'
                };
            }

            if (!this.modelManager) {
                throw new Error('Model manager not initialized for Ollama validation');
            }

            this.logger.info('ValidationService', `Validating models: ${modelNames.join(', ')}`);
            
            // Check server availability first
            if (!await this.modelManager.checkServerAvailability()) {
                throw new Error('Ollama server is not accessible. Please ensure Ollama is running.');
            }

            // Ensure all required models are available (auto-download if missing)
            await this.modelManager.ensureModelsAvailable(modelNames, true);
            
            this.logger.info('ValidationService', 'All required models are available');
            return {
                success: true,
                message: `All required models are available: ${modelNames.join(', ')}`
            };
            
        } catch (error) {
            this.logger.error('ValidationService', 'Model validation failed', error);
            
            let message = 'Model validation failed';
            if (error instanceof Error) {
                message = error.message;
            }
            
            return {
                success: false,
                message,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Validate database accessibility and integrity
     */
    async validateDatabase(databaseService: DatabaseService): Promise<ValidationResult> {
        try {
            this.logger.info('ValidationService', 'Validating database...');
            
            // Test basic database functionality by trying to get notes count
            const allNotes = await databaseService.getAllNotes();
            
            // If we can get notes, the database is working
            this.logger.info('ValidationService', `Database validation successful - found ${allNotes.length} notes`);
            return {
                success: true,
                message: `Database is accessible and working (${allNotes.length} notes found)`
            };
            
        } catch (error) {
            this.logger.error('ValidationService', 'Database validation failed', error);
            
            let message = 'Database validation failed';
            if (error instanceof Error) {
                message = error.message;
            }
            
            return {
                success: false,
                message,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Test the complete embedding pipeline
     */
    async validateEmbeddingPipeline(provider: EmbeddingProvider): Promise<ValidationResult> {
        try {
            this.logger.info('ValidationService', 'Testing embedding pipeline...');
            
            // Test with a simple text
            const testText = 'This is a test for embedding validation.';
            const embedding = await provider.embed_one(testText);
            
            if (!embedding || embedding.length === 0) {
                throw new Error('Provider returned empty embedding');
            }
            
            this.logger.info('ValidationService', `Embedding pipeline test successful (${embedding.length} dimensions)`);
            return {
                success: true,
                message: `Embedding pipeline working correctly (${embedding.length} dimensions)`
            };
            
        } catch (error) {
            this.logger.error('ValidationService', 'Embedding pipeline test failed', error);
            
            let message = 'Embedding pipeline test failed';
            if (error instanceof Error) {
                message = error.message;
            }
            
            return {
                success: false,
                message,
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Perform comprehensive system validation
     */
    async validateSystem(
        provider: EmbeddingProvider, 
        databaseService: DatabaseService, 
        requiredModels: string[] = []
    ): Promise<SystemValidationResult> {
        this.logger.info('ValidationService', 'Starting comprehensive system validation...');
        
        // Perform all validations
        const [embeddingResult, databaseResult, modelsResult] = await Promise.allSettled([
            this.validateEmbeddingProvider(provider),
            this.validateDatabase(databaseService),
            this.validateModels(provider, requiredModels)
        ]);

        // Extract results
        const embeddingProvider = embeddingResult.status === 'fulfilled' 
            ? embeddingResult.value 
            : { success: false, message: 'Validation failed', error: embeddingResult.reason };
            
        const database = databaseResult.status === 'fulfilled' 
            ? databaseResult.value 
            : { success: false, message: 'Validation failed', error: databaseResult.reason };
            
        const models = modelsResult.status === 'fulfilled' 
            ? modelsResult.value 
            : { success: false, message: 'Validation failed', error: modelsResult.reason };

        // Test embedding pipeline if basic validations passed
        let pipelineResult: ValidationResult = { success: true, message: 'Skipped' };
        if (embeddingProvider.success && models.success) {
            try {
                pipelineResult = await this.validateEmbeddingPipeline(provider);
            } catch (error) {
                pipelineResult = {
                    success: false,
                    message: 'Pipeline test failed',
                    error: error instanceof Error ? error : new Error(String(error))
                };
            }
        }

        // Determine overall result
        const allSuccessful = embeddingProvider.success && database.success && models.success && pipelineResult.success;
        
        const overall: ValidationResult = {
            success: allSuccessful,
            message: allSuccessful 
                ? 'All system validations passed successfully'
                : 'One or more system validations failed'
        };

        const result: SystemValidationResult = {
            embeddingProvider,
            database,
            models,
            overall
        };

        this.logger.info('ValidationService', `System validation completed. Overall success: ${allSuccessful}`);
        
        // Show user feedback
        if (allSuccessful) {
            new Notice('System validation successful - Tezcat is ready!', 3000);
        } else {
            const failures = [];
            if (!embeddingProvider.success) failures.push('Provider');
            if (!database.success) failures.push('Database');
            if (!models.success) failures.push('Models');
            if (!pipelineResult.success) failures.push('Pipeline');
            
            new Notice(`Validation failed: ${failures.join(', ')}`, 5000);
        }

        return result;
    }

    /**
     * Get user-friendly validation summary
     */
    getValidationSummary(result: SystemValidationResult): string {
        const lines = [
            `Provider: ${result.embeddingProvider.success ? 'Ready' : 'Issue'} - ${result.embeddingProvider.message}`,
            `Database: ${result.database.success ? 'Ready' : 'Issue'} - ${result.database.message}`,
            `Models: ${result.models.success ? 'Ready' : 'Issue'} - ${result.models.message}`,
            `Overall: ${result.overall.success ? 'Ready' : 'Issue'} - ${result.overall.message}`
        ];
        
        return lines.join('\n');
    }
}