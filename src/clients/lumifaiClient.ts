import {
  Client,
  ClientInstance,
  composeContext,
  generateMessageResponse,
  getEmbeddingZeroVector,
  IAgentRuntime,
  messageCompletionFooter,
  ModelClass,
  stringToUuid,
  elizaLogger,
} from "@elizaos/core";
import { pipeDataStreamToResponse } from "ai";
import fastify, { FastifyInstance } from "fastify";
import fs from "fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Chain, goerli, hardhat, mainnet, sepolia } from "viem/chains";

var messageHandlerTemplate =
  // {{goals}}
  // "# Action Examples" is already included
  `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

interface LumifaiConfig {
  privateKeyPath: string;
  agentRegistrationContract: string;
  agentId: string;
  rpcUrl: string;
  chain: string;
}

export class LumifaiClientManager {
  private publicClient;
  private walletClient;
  private accessToken: string | null = null;
  private server: FastifyInstance;
  private runtime: IAgentRuntime;

  private readonly agentRegistrationAbi = parseAbi([
    "function getChallenge(string calldata _domain) external view returns (string memory)",
    "function verifyAndRegister(string calldata _domain,string calldata _challenge,bytes calldata _signature) external returns (bool)",
    "event AppAuthorized(string indexed domain,string uiDomain,string accessToken,uint256 expiration)",
  ]);

  constructor() {
    this.server = fastify({
      logger: true,
    });
  }

  private resolveChain(chainString: string): Chain {
    const chainMap: { [key: string]: Chain } = {
      mainnet: mainnet,
      sepolia: sepolia,
      goerli: goerli,
      hardhat: hardhat,
    };

    const chain = chainMap[chainString.toLowerCase()];
    if (!chain) {
      throw new Error(
        `Unsupported chain: ${chainString}. Supported chains are: ${Object.keys(chainMap).join(", ")}`,
      );
    }

    return chain;
  }

  private async getConfigFromRuntime(runtime: IAgentRuntime) {
    const privateKeyPath = runtime.getSetting("LUMIFAI_PRIVATE_KEY_PATH");
    const agentRegistrationContract = runtime.getSetting(
      "LUMIFAI_AGENT_REGISTRATION_CONTRACT",
    );
    const agentId = runtime.getSetting("LUMIFAI_AGENT_ID");
    const rpcUrl = runtime.getSetting("LUMIFAI_RPC_URL");
    const chain = runtime.getSetting("LUMIFAI_CHAIN");

    if (
      !privateKeyPath ||
      !agentRegistrationContract ||
      !agentId ||
      !rpcUrl ||
      !chain
    ) {
      throw new Error("Missing required Lumifai configuration settings");
    }

    return {
      privateKeyPath,
      agentRegistrationContract,
      agentId,
      rpcUrl,
      chain,
    };
  }

  private async setupServer() {
    // Health check endpoint
    this.server.get("/health", async () => {
      return { status: "ok" };
    });

    // Chat endpoint
    this.server.post<{
      Body: {
        messages: Array<{
          role: string;
          content: Array<{
            type: string;
            text: string;
          }>;
        }>;
        tools: Array<any>;
        unstable_assistantMessageId: string;
        runConfig: Record<string, any>;
      };
    }>("/api/chat", {
      schema: {
        body: {
          type: "object",
          required: ["messages"],
          properties: {
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  content: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        text: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            tools: { type: "array" },
            unstable_assistantMessageId: { type: "string" },
            runConfig: { type: "object" },
          },
        },
      },
      handler: async (request, reply) => {
        try {
          const lastMessage =
            request.body.messages[request.body.messages.length - 1];
          const prompt = lastMessage.content[0].text;

          // Create message structure
          const userId = stringToUuid("user-" + Date.now());
          const roomId = stringToUuid("room-" + Date.now());

          // Ensure connection
          await this.runtime.ensureConnection(
            userId,
            roomId,
            "User",
            "Chat User",
            "direct",
          );

          // Create message content
          const content = {
            text: prompt,
            attachments: [],
            source: "direct",
            inReplyTo: undefined,
          };

          // Create user message
          const userMessage = {
            content,
            userId,
            roomId,
            agentId: this.runtime.agentId,
          };
          const messageId = stringToUuid(Date.now().toString());
          const memory = {
            id: stringToUuid(messageId + "-" + userId),
            ...userMessage,
            agentId: this.runtime.agentId,
            userId,
            roomId,
            content,
            createdAt: Date.now(),
          };
          await this.runtime.messageManager.addEmbeddingToMemory(memory);
          await this.runtime.messageManager.createMemory(memory);

          // Compose state and generate response
          let state = await this.runtime.composeState(userMessage, {
            agentName: (this.runtime as any).character.name,
          });

          // Process message and get response
          const context = composeContext({
            state,
            template: messageHandlerTemplate,
          });
          const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
          });
          // const response = await this.runtime.processMessage(
          //   userMessage,
          //   state,
          // );
          if (!response) {
            reply.status(500).send("No response from generateMessageResponse");
            return;
          }
          const responseMessage = {
            id: stringToUuid(messageId + "-" + this.runtime.agentId),
            ...userMessage,
            userId: this.runtime.agentId,
            content: response,
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now(),
          };
          await this.runtime.messageManager.createMemory(responseMessage);
          state = await this.runtime.updateRecentMessageState(state);
          let message = null;
          await this.runtime.processActions(
            memory,
            [responseMessage],
            state,
            async (newMessages) => {
              message = newMessages;
              return [memory];
            },
          );
          await this.runtime.evaluate(memory, state);
          const action = this.runtime.actions.find(
            (a) => a.name === response.action,
          );
          try {
            pipeDataStreamToResponse(reply.raw, {
              status: 200,
              statusText: "OK",
              execute: async (dataStream) => {
                if (response) {
                  // Send final response
                  dataStream.write(`0:${JSON.stringify(response.text)}\n`);
                }
              },
            });
          } catch (error) {
            elizaLogger.error(error);
            reply.status(500).send({
              error: "Failed to process chat request",
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
          // const shouldSuppressInitialMessage = action?.suppressInitialMessage;
          // if (!shouldSuppressInitialMessage) {
          //   if (message) {
          //     return reply.send([response, message]);
          //   } else {
          //     return reply.send([response]);
          //   }
          // } else {
          //   if (message) {
          //     return reply.send([message]);
          //   } else {
          //     return reply.send([]);
          //   }
          // }
        } catch (error) {
          elizaLogger.error("Chat request failed:", error);
          reply.status(500).send({ error: "Internal Server Error" });
        }
      },
    });

    const port = parseInt(this.runtime.getSetting("SERVER_PORT") || "3000");
    await this.server.listen({ port });
    console.log(`Server listening on port ${port}`);
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    try {
      this.runtime = runtime;
      const config = await this.getConfigFromRuntime(runtime);

      // Setup blockchain clients
      const chain = this.resolveChain(config.chain);
      this.publicClient = createPublicClient({
        transport: http(config.rpcUrl),
        chain,
      });

      const privateKey = fs.readFileSync(config.privateKeyPath, "utf8").trim();
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      this.walletClient = createWalletClient({
        account,
        transport: http(config.rpcUrl),
        chain,
      });

      // Register agent
      await this.registerAgent(config);
      await this.setupEventListener(config);

      // Setup server
      await this.setupServer();
    } catch (error) {
      console.error("Initialization failed:", error);
      throw error;
    }
  }

  private async registerAgent(config: LumifaiConfig): Promise<void> {
    try {
      console.log(`Starting agent registration for ${config.agentId}`);

      const challenge = await this.publicClient.readContract({
        address: config.agentRegistrationContract as `0x${string}`,
        abi: this.agentRegistrationAbi,
        functionName: "getChallenge",
        args: [config.agentId],
      });
      console.log("Received challenge:", challenge);

      const messageHash = keccak256(stringToHex(challenge as string));
      const signature = await this.walletClient.signMessage({
        message: {
          raw: toBytes(messageHash),
        },
      });
      console.log("Challenge signed successfully");

      const tx = await this.walletClient.writeContract({
        address: config.agentRegistrationContract as `0x${string}`,
        abi: this.agentRegistrationAbi,
        functionName: "verifyAndRegister",
        args: [config.agentId, challenge, signature],
      });

      console.log("Registration transaction submitted:", tx);
    } catch (error) {
      console.error("Agent registration failed:", error);
      throw error;
    }
  }

  private async setupEventListener(config: LumifaiConfig): Promise<void> {
    try {
      console.log("Setting up event listener for AppAuthorized event");

      this.publicClient.watchContractEvent({
        address: config.agentRegistrationContract as `0x${string}`,
        abi: this.agentRegistrationAbi,
        eventName: "AppAuthorized",
        onLogs: (logs) => {
          for (const log of logs) {
            const [agentId, , accessToken] = log.args as [
              string,
              string,
              string,
              bigint,
            ];
            if (agentId === config.agentId) {
              this.accessToken = accessToken;
              console.log(
                `Agent registered successfully with access token: ${accessToken}`,
              );
            }
          }
        },
      });
    } catch (error) {
      console.error("Failed to setup event listener:", error);
      throw error;
    }
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  public async cleanup(): Promise<void> {
    await this.server.close();
    console.log("Server closed and resources cleaned up");
  }
}

export class LumifaiClient implements Client {
  name = "lumifai";
  private clientManager: LumifaiClientManager | null = null;

  private getConfigFromRuntime(runtime: IAgentRuntime): LumifaiConfig {
    const privateKeyPath = runtime.getSetting("LUMIFAI_PRIVATE_KEY_PATH");
    const agentRegistrationContract = runtime.getSetting(
      "LUMIFAI_AGENT_REGISTRATION_CONTRACT",
    );
    const agentId = runtime.getSetting("LUMIFAI_AGENT_ID");
    const rpcUrl = runtime.getSetting("LUMIFAI_RPC_URL");
    const chain = runtime.getSetting("LUMIFAI_CHAIN");

    if (
      !privateKeyPath ||
      !agentRegistrationContract ||
      !agentId ||
      !rpcUrl ||
      !chain
    ) {
      throw new Error("Missing required Lumifai configuration settings");
    }

    return {
      privateKeyPath,
      agentRegistrationContract,
      agentId,
      rpcUrl,
      chain,
    };
  }

  async start(runtime: IAgentRuntime): Promise<ClientInstance> {
    try {
      const config = this.getConfigFromRuntime(runtime);
      this.clientManager = new LumifaiClientManager();
      // await this.clientManager.initialize(config);

      return {
        stop: async () => {},
      };
    } catch (error) {
      console.error("Failed to start Lumifai client:", error);
      throw error;
    }
  }
}
