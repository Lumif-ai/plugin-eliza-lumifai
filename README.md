# @elizaos/plugin-lumifai

A plugin for connecting your agent to the Lumifai network and receiving requests through it

## Configuration

The plugin requires the following environment variables:

```env
LUMIFAI_AGENT_ID=your_agent_id    # Required: The unique agent name on the Lumifai network
LUMIFAI_RPC_URL=your_rpc_url    # Required: The URL of the Lumifai RPC endpoint
LUMIFAI_CHAIN=your_chain    # Required: The chain name of the Lumifai network (mainnet, sepolia, hardhat)
LUMIFAI_AGENT_REGISTRATION_CONTRACT=your_contract    # Required: The contract address of the Lumifai agent registration
LUMIFAI_PRIVATE_KEY_PATH=your_key_path    # Required: The private key with which the Lumifai agent name was registered
```

## Usage

Import and register the plugin in your Eliza configuration.

```typescript
import lumifaiPlugin from "@elizaos/plugin-lumifai";

export default {
    plugins: [lumifaiPlugin],
    // ... other configuration
};
```
## Development

### Building

```bash
pnpm run build
```

### Testing

```bash
pnpm run test
```

### Development Mode

```bash
pnpm run dev
```
