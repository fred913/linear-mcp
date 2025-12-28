#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import express, { type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { LinearAuth } from './auth.js'
import { HandlerFactory } from './core/handlers/handler.factory.js'
import { toolSchemas } from './core/types/tool.types.js'
import { LinearGraphQLClient } from './graphql/client.js'

/**
 * Main server class that handles MCP protocol interactions.
 * Delegates tool operations to domain-specific handlers.
 */
class LinearServer {
  private server: Server
  private auth: LinearAuth
  private graphqlClient?: LinearGraphQLClient
  private handlerFactory: HandlerFactory
  private transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  constructor() {
    this.server = new Server(
      {
        name: 'linear-server',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {},
        },
      }
    )

    this.auth = new LinearAuth()

    // Initialize with API Key if available
    const apiKey = process.env.LINEAR_API_KEY
    if (apiKey) {
      this.auth.initialize({
        type: 'api',
        apiKey
      })
      this.graphqlClient = new LinearGraphQLClient(this.auth.getClient())
    }

    // Initialize handler factory
    this.handlerFactory = new HandlerFactory(this.auth, this.graphqlClient)

    this.setupRequestHandlers()

    // Error handling
    this.server.onerror = (error: Error) => console.error('[MCP Error]', error)
    process.on('SIGINT', async () => {
      await this.server.close()
      process.exit(0)
    })
  }

  private setupRequestHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(toolSchemas),
    }))

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { handler, method } = this.handlerFactory.getHandlerForTool(request.params.name)
        // Use type assertion to handle dynamic method access
        return await (handler as any)[method](request.params.arguments)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('No handler found')) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          )
        }
        throw error
      }
    })
  }

  async run() {
    const app = express()
    app.use(express.json())
    const port = process.env.PORT || 3000

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', service: 'linear-mcp' })
    })

    // POST endpoint for MCP requests
    app.post('/mcp', async (req: Request, res: Response) => {
      console.log('Received MCP request:', req.body)
      try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        let transport: StreamableHTTPServerTransport

        if (sessionId && this.transports[sessionId]) {
          // Reuse existing transport
          transport = this.transports[sessionId]
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sessionId => {
              // Store the transport by session ID when session is initialized
              console.log(`Session initialized with ID: ${sessionId}`)
              this.transports[sessionId] = transport
            }
          })

          // Connect the transport to the MCP server
          await this.server.connect(transport)

          // Handle the request - the onsessioninitialized callback will store the transport
          await transport.handleRequest(req, res, req.body)
          return // Already handled
        } else {
          // Invalid request - no session ID or not initialization request
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided'
            },
            id: null
          })
          return
        }

        // Handle the request with existing transport
        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error'
            },
            id: null
          })
        }
      }
    })

    // GET endpoint for SSE streams
    app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !this.transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }

      console.log(`Establishing SSE stream for session ${sessionId}`)
      const transport = this.transports[sessionId]
      await transport.handleRequest(req, res)
    })

    app.listen(port, () => {
      console.error(`Linear MCP server running on http://localhost:${port}`)
      console.error(`MCP endpoint: http://localhost:${port}/mcp`)
    })
  }
}

const server = new LinearServer()
server.run().catch(console.error)
