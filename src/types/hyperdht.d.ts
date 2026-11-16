// HyperDHT ships no types; the app only touches it through the small interface in electron/p2p-core.ts
declare module 'hyperdht' { const DHT: any; export default DHT; }
declare module 'hyperdht/testnet.js' { const createTestnet: any; export default createTestnet; }
