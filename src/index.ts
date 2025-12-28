#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { Readable } from 'stream';
import { LinearAuth } from './auth.js';
import { LinearGraphQLClient } from './graphql/client.js';
import { HandlerFactory } from './core/handlers/handler.factory.js';
import { toolSchemas } from './core/types/tool.types.js';

/**
 * Main server class that handles MCP protocol interactions.
 * Delegates tool operations to domain-specific handlers.
 */
class LinearServer {
  private server: Server;
  private auth: LinearAuth;
  private graphqlClient?: LinearGraphQLClient;
  private handlerFactory: HandlerFactory;

  constructor() {
    this.server = new Server(
      {
        name: 'linear-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.auth = new LinearAuth();
    
    // Initialize with API Key if available
    const apiKey = process.env.LINEAR_API_KEY;
    if (apiKey) {
      this.auth.initialize({
        type: 'api',
        apiKey
      });
      this.graphqlClient = new LinearGraphQLClient(this.auth.getClient());
    }
    
    // Initialize handler factory
    this.handlerFactory = new HandlerFactory(this.auth, this.graphqlClient);
    
    this.setupRequestHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupRequestHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(toolSchemas),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { handler, method } = this.handlerFactory.getHandlerForTool(request.params.name);
        // Use type assertion to handle dynamic method access
        return await (handler as any)[method](request.params.arguments);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('No handler found')) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
        }
        throw error;
      }
    });
  }

  async run() {
    const app = express();
    const port = process.env.PORT || 3000;

    // Parse JSON bodies
    app.use(express.json());

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', service: 'linear-mcp' });
    });

    // HTTP streaming endpoint for MCP
    app.post('/mcp', async (req: Request, res: Response) => {
      console.error('New MCP HTTP streaming connection');

      // Set headers for streaming
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // Create readable/writable streams for the transport
        const inputStream = new Readable({
          read() {}
        });
        
        const outputStream = res;

        // Push the request body to the input stream
        if (req.body) {
          inputStream.push(JSON.stringify(req.body));
          inputStream.push(null); // Signal end of input
        }

        // Create a simple transport adapter
        const transport = {
          start: async () => {
            console.error('Transport started');
          },
          send: async (message: any) => {
            outputStream.write(JSON.stringify(message) + '\n');
          },
          close: async () => {
            outputStream.end();
          }
        };

        // Handle the MCP request directly
        const message = req.body;
        
        if (message.method === 'tools/list') {
          const result = await this.server.request(
            { method: 'tools/list', params: {} },
            ListToolsRequestSchema
          );
          await transport.send(result);
        } else if (message.method === 'tools/call') {
          const result = await this.server.request(
            message,
            CallToolRequestSchema
          );
          await transport.send(result);
        } else {
          await transport.send({
            error: {
              code: ErrorCode.MethodNotFound,
              message: `Unknown method: ${message.method}`
            }
          });
        }

        await transport.close();
        
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              code: ErrorCode.InternalError,
              message: error instanceof Error ? error.message : 'Internal server error'
            }
          });
        }
      }
    });

    app.listen(port, () => {
      console.error(`Linear MCP server running on http://localhost:${port}`);
      console.error(`HTTP streaming endpoint: http://localhost:${port}/mcp`);
    });
  }
}

const server = new LinearServer();
server.run().catch(console.error);
