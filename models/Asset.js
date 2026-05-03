// models/Asset.js
import mongoose from 'mongoose';

const assetSchema = new mongoose.Schema({
    onChainId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    url: { type: String, required: true },
    price: { type: String, required: true },
    publisher: { type: String, required: true },
    timestamp: { type: Number, default: Date.now },

    // Use an array to record all wallet addresses that have purchased this data.
    purchasers: { type: [String], default: [] }
});

export default mongoose.model('Asset', assetSchema);