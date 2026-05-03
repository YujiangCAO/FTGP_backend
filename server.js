// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import Asset from './models/Asset.js';

import CryptoJS from 'crypto-js';
import { ethers } from 'ethers';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const CONTRACT_ADDRESS = "0xD75d05f5d72dC4333036286177FFD90b3465B713";
const CONTRACT_ABI = [
    "function hasAccess(address user, uint256 datasetId) view returns (bool)"
];

// Access all publicly available assets (Market.jsx)
app.get('/api/assets', async (req, res) => {
    try {
        const assets = await Asset.find().sort({ timestamp: -1 });
        res.json(assets);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error fetching assets' });
    }
});

// Acquire the publisher's assets (Profile.jsx)
app.get('/api/assets/publisher/:address', async (req, res) => {
    try {
        const address = req.params.address;
        const assets = await Asset.find({
            publisher: { $regex: new RegExp(`^${address}$`, 'i') }
        }).sort({ timestamp: -1 });
        res.json(assets);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching user assets' });
    }
});

// Publish a new asset (encrypt the URL and store it in the database).
app.post('/api/assets', async (req, res) => {
    try {
        const { onChainId, name, description, url, price, publisher } = req.body;

        if(!onChainId || !name || !publisher || !url) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const encryptedUrl = CryptoJS.AES.encrypt(
            url,
            process.env.SERVER_ENCRYPTION_KEY
        ).toString();

        const newAsset = new Asset({
            onChainId,
            name,
            description,
            url: encryptedUrl,
            price,
            publisher,
            timestamp: Date.now()
        });

        await newAsset.save();
        res.status(201).json({ message: 'Asset encrypted and saved to database', asset: newAsset });
    } catch (error) {
        console.error(error);
        if(error.code === 11000) {
            return res.status(400).json({ message: 'Asset with this onChainId already exists' });
        }
        res.status(500).json({ message: 'Server Error saving asset' });
    }
});

// Added download and decryption verification interface (called during download in AssetCard.jsx).
app.post('/api/assets/:onChainId/download', async (req, res) => {
    try {
        const { userAddress, signature, message } = req.body;
        const { onChainId } = req.params;

        if (!userAddress || !signature || !message) {
            return res.status(400).json({ message: 'Missing authentication data' });
        }

        // Compatible with v5/v6: Verify signature
        let recoveredAddress;
        try {
            if (ethers.utils && ethers.utils.verifyMessage) {
                recoveredAddress = ethers.utils.verifyMessage(message, signature); // ethers v5
            } else {
                recoveredAddress = ethers.verifyMessage(message, signature); // ethers v6
            }
        } catch (signErr) {
            throw new Error("Signature verification format error.");
        }

        if (recoveredAddress.toLowerCase() !== userAddress.toLowerCase()) {
            return res.status(401).json({ message: "Invalid digital signature. Authentication failed." });
        }

        // Check environment variables
        if (!process.env.RPC_URL) throw new Error("Backend missing RPC_URL in .env");
        if (!process.env.SERVER_ENCRYPTION_KEY) throw new Error("Backend missing SERVER_ENCRYPTION_KEY");

        // Compatible with v5/v6: Connecting to the blockchain
        let provider, contract, onChainIdFormat;
        if (ethers.providers && ethers.providers.JsonRpcProvider) {
            // ethers v5
            provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
            contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
            onChainIdFormat = ethers.BigNumber.from(onChainId);
        } else {
            // ethers v6
            provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
            onChainIdFormat = BigInt(onChainId);
        }

        // Call the contract's hasAccess method to verify permissions.
        const hasPermission = await contract.hasAccess(userAddress, onChainIdFormat);

        if (!hasPermission) {
            return res.status(403).json({ message: "Access Denied: You have not purchased this asset on the blockchain." });
        }

        // Read the database and decrypt it
        const asset = await Asset.findOne({ onChainId: onChainId });
        if (!asset) {
            return res.status(404).json({ message: "Asset not found in database" });
        }

        let finalUrl = asset.url; // The default is to get the original URL first.

        // Attempt to decrypt; if it fails, it indicates that the data is historical plaintext, and the plaintext should be allowed to pass directly.
        try {
            const bytes = CryptoJS.AES.decrypt(asset.url, process.env.SERVER_ENCRYPTION_KEY);
            const decryptedUrl = bytes.toString(CryptoJS.enc.Utf8);
            // If the string is successfully decrypted and it is a valid HTTP/IPFS connection, then overwrite.
            if (decryptedUrl && (decryptedUrl.startsWith("http") || decryptedUrl.startsWith("ipfs"))) {
                finalUrl = decryptedUrl;
            }
        } catch (decryptErr) {
            console.warn(`⚠️ Warning: Asset ${onChainId} decrypt failed, treating as legacy plain-text URL.`);
        }

        // Return to final URL
        res.json({ url: finalUrl });

    } catch (error) {
        console.error("Download API Detailed Error:", error);
        res.status(500).json({ message: error.message || 'Unknown Server Error' });
    }
});

// Record purchase behavior (used to display the purchased list in the user's center).
app.post('/api/assets/:onChainId/purchase', async (req, res) => {
    try {
        const { buyer } = req.body;
        const asset = await Asset.findOne({ onChainId: req.params.onChainId });

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const buyerRegex = new RegExp(`^${buyer}$`, 'i');
        const alreadyPurchased = asset.purchasers.some(p => buyerRegex.test(p));

        if (!alreadyPurchased) {
            asset.purchasers.push(buyer);
            await asset.save();
        }

        res.json({ message: 'Purchase recorded successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error recording purchase' });
    }
});

app.get('/api/assets/purchased/:address', async (req, res) => {
    try {
        const address = req.params.address;
        const assets = await Asset.find({
            purchasers: { $regex: new RegExp(`^${address}$`, 'i') }
        }).sort({ timestamp: -1 });

        res.json(assets);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error fetching purchased assets' });
    }
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB Connected Successfully');
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => console.error('MongoDB Connection Error:', err));