// src/clients/lumifaiClient.ts
import {
  composeContext,
  generateMessageResponse,
  getEmbeddingZeroVector,
  messageCompletionFooter,
  ModelClass,
  stringToUuid,
  elizaLogger
} from "@elizaos/core";
import { pipeDataStreamToResponse } from "ai";
import fastify from "fastify";
import fs from "fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { goerli, hardhat, mainnet, sepolia } from "viem/chains";
var messageHandlerTemplate = (
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
` + messageCompletionFooter
);
var LumifaiClientManager = class {
  publicClient;
  walletClient;
  accessToken = null;
  server;
  runtime;
  agentRegistrationAbi = parseAbi([
    "function getChallenge(string calldata _domain) external view returns (string memory)",
    "function verifyAndRegister(string calldata _domain,string calldata _challenge,bytes calldata _signature) external returns (bool)",
    "event AppAuthorized(string indexed domain,string uiDomain,string accessToken,uint256 expiration)"
  ]);
  constructor() {
    this.server = fastify({
      logger: true
    });
  }
  resolveChain(chainString) {
    const chainMap = {
      mainnet,
      sepolia,
      goerli,
      hardhat
    };
    const chain = chainMap[chainString.toLowerCase()];
    if (!chain) {
      throw new Error(
        `Unsupported chain: ${chainString}. Supported chains are: ${Object.keys(chainMap).join(", ")}`
      );
    }
    return chain;
  }
  async getConfigFromRuntime(runtime) {
    const privateKeyPath = runtime.getSetting("LUMIFAI_PRIVATE_KEY_PATH");
    const agentRegistrationContract = runtime.getSetting(
      "LUMIFAI_AGENT_REGISTRATION_CONTRACT"
    );
    const agentId = runtime.getSetting("LUMIFAI_AGENT_ID");
    const rpcUrl = runtime.getSetting("LUMIFAI_RPC_URL");
    const chain = runtime.getSetting("LUMIFAI_CHAIN");
    if (!privateKeyPath || !agentRegistrationContract || !agentId || !rpcUrl || !chain) {
      throw new Error("Missing required Lumifai configuration settings");
    }
    return {
      privateKeyPath,
      agentRegistrationContract,
      agentId,
      rpcUrl,
      chain
    };
  }
  async setupServer() {
    this.server.get("/health", async () => {
      return { status: "ok" };
    });
    this.server.post("/api/chat", {
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
                        text: { type: "string" }
                      }
                    }
                  }
                }
              }
            },
            tools: { type: "array" },
            unstable_assistantMessageId: { type: "string" },
            runConfig: { type: "object" }
          }
        }
      },
      handler: async (request, reply) => {
        try {
          const lastMessage = request.body.messages[request.body.messages.length - 1];
          const prompt = lastMessage.content[0].text;
          const userId = stringToUuid("user-" + Date.now());
          const roomId = stringToUuid("room-" + Date.now());
          await this.runtime.ensureConnection(
            userId,
            roomId,
            "User",
            "Chat User",
            "direct"
          );
          const content = {
            text: prompt,
            attachments: [],
            source: "direct",
            inReplyTo: void 0
          };
          const userMessage = {
            content,
            userId,
            roomId,
            agentId: this.runtime.agentId
          };
          const messageId = stringToUuid(Date.now().toString());
          const memory = {
            id: stringToUuid(messageId + "-" + userId),
            ...userMessage,
            agentId: this.runtime.agentId,
            userId,
            roomId,
            content,
            createdAt: Date.now()
          };
          await this.runtime.messageManager.addEmbeddingToMemory(memory);
          await this.runtime.messageManager.createMemory(memory);
          let state = await this.runtime.composeState(userMessage, {
            agentName: this.runtime.character.name
          });
          const context = composeContext({
            state,
            template: messageHandlerTemplate
          });
          const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE
          });
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
            createdAt: Date.now()
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
            }
          );
          await this.runtime.evaluate(memory, state);
          const action = this.runtime.actions.find(
            (a) => a.name === response.action
          );
          try {
            pipeDataStreamToResponse(reply.raw, {
              status: 200,
              statusText: "OK",
              execute: async (dataStream) => {
                if (response) {
                  dataStream.write(`0:${JSON.stringify(response.text)}
`);
                }
              }
            });
          } catch (error) {
            elizaLogger.error(error);
            reply.status(500).send({
              error: "Failed to process chat request",
              message: error instanceof Error ? error.message : "Unknown error"
            });
          }
        } catch (error) {
          elizaLogger.error("Chat request failed:", error);
          reply.status(500).send({ error: "Internal Server Error" });
        }
      }
    });
    const port = parseInt(this.runtime.getSetting("SERVER_PORT") || "3000");
    await this.server.listen({ port });
    console.log(`Server listening on port ${port}`);
  }
  async initialize(runtime) {
    try {
      this.runtime = runtime;
      const config = await this.getConfigFromRuntime(runtime);
      const chain = this.resolveChain(config.chain);
      this.publicClient = createPublicClient({
        transport: http(config.rpcUrl),
        chain
      });
      const privateKey = fs.readFileSync(config.privateKeyPath, "utf8").trim();
      const account = privateKeyToAccount(privateKey);
      this.walletClient = createWalletClient({
        account,
        transport: http(config.rpcUrl),
        chain
      });
      await this.registerAgent(config);
      await this.setupEventListener(config);
      await this.setupServer();
    } catch (error) {
      console.error("Initialization failed:", error);
      throw error;
    }
  }
  async registerAgent(config) {
    try {
      console.log(`Starting agent registration for ${config.agentId}`);
      const challenge = await this.publicClient.readContract({
        address: config.agentRegistrationContract,
        abi: this.agentRegistrationAbi,
        functionName: "getChallenge",
        args: [config.agentId]
      });
      console.log("Received challenge:", challenge);
      const messageHash = keccak256(stringToHex(challenge));
      const signature = await this.walletClient.signMessage({
        message: {
          raw: toBytes(messageHash)
        }
      });
      console.log("Challenge signed successfully");
      const tx = await this.walletClient.writeContract({
        address: config.agentRegistrationContract,
        abi: this.agentRegistrationAbi,
        functionName: "verifyAndRegister",
        args: [config.agentId, challenge, signature]
      });
      console.log("Registration transaction submitted:", tx);
    } catch (error) {
      console.error("Agent registration failed:", error);
      throw error;
    }
  }
  async setupEventListener(config) {
    try {
      console.log("Setting up event listener for AppAuthorized event");
      this.publicClient.watchContractEvent({
        address: config.agentRegistrationContract,
        abi: this.agentRegistrationAbi,
        eventName: "AppAuthorized",
        onLogs: (logs) => {
          for (const log of logs) {
            const [agentId, , accessToken] = log.args;
            if (agentId === config.agentId) {
              this.accessToken = accessToken;
              console.log(
                `Agent registered successfully with access token: ${accessToken}`
              );
            }
          }
        }
      });
    } catch (error) {
      console.error("Failed to setup event listener:", error);
      throw error;
    }
  }
  getAccessToken() {
    return this.accessToken;
  }
  async cleanup() {
    await this.server.close();
    console.log("Server closed and resources cleaned up");
  }
};
var LumifaiClient = class {
  name = "lumifai";
  clientManager = null;
  getConfigFromRuntime(runtime) {
    const privateKeyPath = runtime.getSetting("LUMIFAI_PRIVATE_KEY_PATH");
    const agentRegistrationContract = runtime.getSetting(
      "LUMIFAI_AGENT_REGISTRATION_CONTRACT"
    );
    const agentId = runtime.getSetting("LUMIFAI_AGENT_ID");
    const rpcUrl = runtime.getSetting("LUMIFAI_RPC_URL");
    const chain = runtime.getSetting("LUMIFAI_CHAIN");
    if (!privateKeyPath || !agentRegistrationContract || !agentId || !rpcUrl || !chain) {
      throw new Error("Missing required Lumifai configuration settings");
    }
    return {
      privateKeyPath,
      agentRegistrationContract,
      agentId,
      rpcUrl,
      chain
    };
  }
  async start(runtime) {
    try {
      const config = this.getConfigFromRuntime(runtime);
      this.clientManager = new LumifaiClientManager();
      return {
        stop: async () => {
        }
      };
    } catch (error) {
      console.error("Failed to start Lumifai client:", error);
      throw error;
    }
  }
};

// src/index.ts
var plugin = {
  name: "lumifaiPlugin",
  description: "Connect to the Lumifai Network",
  actions: [],
  evaluators: [],
  providers: [],
  services: [],
  clients: [new LumifaiClient()],
  adapters: []
};
var index_default = plugin;
export {
  LumifaiClientManager,
  index_default as default
};
//# sourceMappingURL=index.js.map