import {
  Service,
  type IAgentRuntime,
  ServiceType,
  Action,
} from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface IMcpClientService extends Service {
  listTools(): Promise<McpTool[]>;
  invokeTool(toolName: string, params: any): Promise<any>;
  listResourceTemplates(): Promise<ResourceTemplate[]>;
  readResource(params: { uri: string }): Promise<any>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

export interface McpClientConfig {
  url: string;
  apiKey?: string;
  name?: string;
  version?: string;
}

export class MCPClientService extends Service implements IMcpClientService {
  private clients: Map<string, Client> = new Map();
  private toolsCache: Map<string, McpTool> = new Map();
  private toolToClientMap: Map<string, Client> = new Map();
  private toolSchemas: Map<string, z.ZodSchema> = new Map();
  private resourceTemplatesCache: Map<string, ResourceTemplate> = new Map();

  constructor(private mcpConfigs: McpClientConfig[]) {
    super();
  }

  async listResourceTemplates(): Promise<ResourceTemplate[]> {
    try {
      const templates: ResourceTemplate[] = [];

      // Get templates from all connected clients
      for (const client of Array.from(this.clients.values())) {
        const response = await client.listResourceTemplates();

        if (response && Array.isArray(response.templates)) {
          response.templates.forEach((template: any) => {
            const resourceTemplate: ResourceTemplate = {
              uriTemplate: template.uriTemplate,
              name: template.name,
              description: template.description,
              mimeType: template.mimeType,
            };

            // Cache the template
            this.resourceTemplatesCache.set(
              template.uriTemplate,
              resourceTemplate,
            );
            templates.push(resourceTemplate);
          });
        }
      }

      return templates;
    } catch (error) {
      console.error("Failed to list resource templates:", error);
      throw error;
    }
  }

  async readResource(params: { uri: string }): Promise<any> {
    try {
      if (!params.uri) {
        throw new Error("URI parameter is required");
      }

      // Try to find a client that can handle this URI
      for (const client of Array.from(this.clients.values())) {
        try {
          const response = await client.readResource({
            uri: params.uri,
          });
          return response;
        } catch (error) {
          // If this client can't handle the URI, try the next one
          continue;
        }
      }

      throw new Error(`No client could handle the URI: ${params.uri}`);
    } catch (error) {
      console.error("Failed to read resource:", error);
      throw error;
    }
  }

  async initialize(_runtime: IAgentRuntime): Promise<void> {
    if (!this.mcpConfigs || this.mcpConfigs.length === 0) {
      throw new Error("No MCP clients configured");
    }

    await this.initializeClients();
  }

  static get serviceType(): ServiceType {
    return ServiceType.WEB_SEARCH;
  }

  private createZodSchema(inputSchema: McpTool["inputSchema"]): z.ZodSchema {
    const schemaShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(inputSchema.properties)) {
      switch (value.type) {
        case "string":
          schemaShape[key] = z.string();
          break;
        case "number":
          schemaShape[key] = z.number();
          break;
        case "boolean":
          schemaShape[key] = z.boolean();
          break;
        // Add more types as needed
        default:
          schemaShape[key] = z.any();
      }
    }

    const schema = z.object(schemaShape);
    return inputSchema.required?.length ? schema.strict().required() : schema;
  }

  private async initializeClients(): Promise<void> {
    try {
      for (const config of this.mcpConfigs) {
        const client = new Client(
          {
            name: config.name || "mcp-client",
            version: config.version || "1.0.0",
          },
          {
            capabilities: {},
          },
        );

        const url = new URL(config.url);
        const transport = new SSEClientTransport(url);

        await client.connect(transport);
        this.clients.set(config.url, client);

        // Get tools from the client
        const response = await client.listTools();
        response.tools.forEach((tool: any) => {
          const mcpTool: McpTool = {
            name: tool.name,
            description: tool.description,
            inputSchema: {
              type: tool.inputSchema.type || "object",
              properties: tool.inputSchema.properties || {},
              required: tool.inputSchema.required || [],
            },
          };

          this.toolsCache.set(mcpTool.name, mcpTool);
          this.toolToClientMap.set(mcpTool.name, client);
          // Create and cache Zod schema for the tool
          this.toolSchemas.set(
            mcpTool.name,
            this.createZodSchema(mcpTool.inputSchema),
          );
        });
      }
    } catch (error) {
      console.error("Failed to initialize MCP clients:", error);
      throw error;
    }
  }

  async listTools(): Promise<McpTool[]> {
    return Array.from(this.toolsCache.values());
  }

  async invokeTool(toolName: string, params: any): Promise<any> {
    const tool = this.toolsCache.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    const client = this.toolToClientMap.get(toolName);
    if (!client) {
      throw new Error(`No client found for tool '${toolName}'`);
    }

    // Validate parameters against the schema
    const schema = this.toolSchemas.get(toolName);
    if (!schema) {
      throw new Error(`Schema not found for tool '${toolName}'`);
    }

    try {
      // Validate params against the schema
      const validatedParams = schema.parse(params);

      // Invoke the tool with validated params
      const result = await client.callTool({
        name: toolName,
        arguments: validatedParams,
      });
      return result;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid parameters for tool '${toolName}': ${error.message}`,
        );
      }
      console.error(`Error invoking tool '${toolName}':`, error);
      throw error;
    }
  }

  getClientForTool(toolName: string): Client | undefined {
    return this.toolToClientMap.get(toolName);
  }

  getToolProvider(toolName: string): string | undefined {
    const client = this.toolToClientMap.get(toolName);
    if (!client) return undefined;

    // Convert entries to array to avoid iterator issues
    const clientEntries = Array.from(this.clients.entries());
    for (const [url, mappedClient] of clientEntries) {
      if (mappedClient === client) {
        return url;
      }
    }
    return undefined;
  }

  async cleanup(): Promise<void> {
    this.clients.clear();
    this.toolsCache.clear();
    this.toolToClientMap.clear();
    this.toolSchemas.clear();
  }
}
