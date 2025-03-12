import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  elizaLogger,
  generateObject,
  ModelClass,
  ServiceType,
} from "@elizaos/core";
import { z } from "zod";
import type { IMcpClientService, McpTool } from "../services/mcpClientService";

interface ActionSchema {
  similes: string[];
  examples: Array<
    Array<{
      user: string;
      content: {
        text: string;
        action?: string;
      };
    }>
  >;
}

export class ActionFactory {
  private static SCHEMA_URI_PREFIX = "file://elizaosactionschema/";

  static async createActions(mcpService: IMcpClientService): Promise<Action[]> {
    try {
      const tools = await mcpService.listTools();
      const resourceTemplates = await mcpService.listResourceTemplates();
      const actions: Action[] = [];

      for (const tool of tools) {
        const actionSchema = await this.getActionSchema(
          mcpService,
          tool.name,
          resourceTemplates,
        );

        const action = await this.createAction(tool, actionSchema);
        actions.push(action);
      }

      return actions;
    } catch (error) {
      elizaLogger.error("Error creating actions:", error);
      throw error;
    }
  }

  private static async getActionSchema(
    mcpService: IMcpClientService,
    toolName: string,
    resourceTemplates: any[],
  ): Promise<ActionSchema | undefined> {
    const schemaTemplate = resourceTemplates.find((template) =>
      template.uriTemplate.startsWith(this.SCHEMA_URI_PREFIX),
    );

    if (!schemaTemplate) {
      return undefined;
    }

    try {
      // Get the provider URL for this tool
      const toolProvider = (mcpService as any).getToolProvider(toolName);
      if (!toolProvider) {
        elizaLogger.warn(`No provider found for tool ${toolName}`);
        return undefined;
      }

      const schemaUri = `${this.SCHEMA_URI_PREFIX}${toolName}`;

      // Get the client for this tool
      const client = (mcpService as any).getClientForTool(toolName);
      if (!client) {
        elizaLogger.warn(`No client found for tool ${toolName}`);
        return undefined;
      }

      // Use the specific client to read the resource
      const schema = await client.readResource({ uri: schemaUri });
      return schema as ActionSchema;
    } catch (error) {
      elizaLogger.warn(`No action schema found for tool ${toolName}:`, error);
      return undefined;
    }
  }

  private static async createAction(
    tool: McpTool,
    actionSchema?: ActionSchema,
  ): Promise<Action> {
    return {
      name: tool.name,
      similes: actionSchema?.similes || [],
      description: tool.description,
      suppressInitialMessage: true,
      examples: actionSchema?.examples || [],

      validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const mcpService = runtime.getService(
          ServiceType.WEB_SEARCH,
        ) as IMcpClientService;

        // Check if there's a valid client for this tool
        const client = (mcpService as any).getClientForTool(tool.name);
        return !!mcpService && !!client;
      },

      handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback,
      ) => {
        try {
          const mcpService = runtime.getService(
            ServiceType.WEB_SEARCH,
          ) as IMcpClientService;

          // Verify we have a client for this tool
          const client = (mcpService as any).getClientForTool(tool.name);
          if (!client) {
            throw new Error(`No client available for tool ${tool.name}`);
          }

          // Create Zod schema from tool's input schema
          const zodSchema = this.createZodSchema(tool.inputSchema);

          // Compose state and generate input object
          const currentState = !state
            ? await runtime.composeState(message)
            : await runtime.updateRecentMessageState(state);
          const inputParams = await generateObject({
            runtime,
            context: currentState.recentMessages,
            modelClass: ModelClass.MEDIUM,
            schema: zodSchema,
          });

          // Invoke the tool using the specific client
          const result = await mcpService.invokeTool(tool.name, inputParams);

          callback({
            text: typeof result === "string" ? result : JSON.stringify(result),
          });
        } catch (error) {
          elizaLogger.error(`Error in ${tool.name} handler:`, error);
          callback({
            text: `Failed to execute ${tool.name}: ${error.message}`,
          });
        }
      },
    };
  }

  private static createZodSchema(
    inputSchema: McpTool["inputSchema"],
  ): z.ZodSchema {
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
        default:
          schemaShape[key] = z.any();
      }
    }

    const schema = z.object(schemaShape);
    return inputSchema.required?.length ? schema.strict().required() : schema;
  }
}
