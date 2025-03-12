import {
  Action,
  AgentRuntime,
  Character,
  Client,
  Evaluator,
  Provider,
  Service,
  type Plugin,
} from "@elizaos/core";
import { webSearch } from "./actions/webSearch";
import { WebSearchService } from "./services/webSearchService";
import { ActionFactory } from "./actions/actionFactory";
import { MCPClientService } from "./services/mcpClientService";
import { LumifaiClient, LumifaiClientManager } from "./clients/lumifaiClient";

const plugin = {
  name: "lumifaiPlugin",
  description: "Connect to the Lumifai Network",
  actions: [],
  evaluators: [],
  providers: [],
  services: [],
  clients: [new LumifaiClient()],
  adapters: [],
};

// class LumifaiPlugin implements Plugin {
//   name: string;
//   npmName?: string;
//   config?: { [key: string]: any; };
//   description: string;
//   actions?: Action[];
//   providers?: Provider[];
//   evaluators?: Evaluator[];
//   services?: Service[];
//   clients?: Client[];
//   adapters?: Adapter[];
//   handlePostCharacterLoaded?: (char: Character) => Promise<Character>;
//   async initialize(runtime: AgentRuntime) {

//   }
// }

export { LumifaiClientManager };
export default plugin;
