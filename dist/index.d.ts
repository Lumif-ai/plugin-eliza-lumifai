import { IAgentRuntime, Client, ClientInstance } from '@elizaos/core';

declare class LumifaiClientManager {
    private publicClient;
    private walletClient;
    private accessToken;
    private server;
    private runtime;
    private readonly agentRegistrationAbi;
    constructor();
    private resolveChain;
    private getConfigFromRuntime;
    private setupServer;
    initialize(runtime: IAgentRuntime): Promise<void>;
    private registerAgent;
    private setupEventListener;
    getAccessToken(): string | null;
    cleanup(): Promise<void>;
}
declare class LumifaiClient implements Client {
    name: string;
    private clientManager;
    private getConfigFromRuntime;
    start(runtime: IAgentRuntime): Promise<ClientInstance>;
}

declare const plugin: {
    name: string;
    description: string;
    actions: any[];
    evaluators: any[];
    providers: any[];
    services: any[];
    clients: LumifaiClient[];
    adapters: any[];
};

export { LumifaiClientManager, plugin as default };
