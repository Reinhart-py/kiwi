const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
let cachedClient = null;

async function getDatabase() {
    if (!cachedClient) {
        cachedClient = new MongoClient(MONGO_URI);
        await cachedClient.connect();
    }
    return cachedClient.db('jules-licensing');
}

const parseBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            resolve(body ? JSON.parse(body) : {});
        } catch (e) {
            reject(e);
        }
    });
});

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        const { key, hwid } = await parseBody(req);
        if (!key) {
            return res.status(400).json({ success: false, message: 'key_required' });
        }

        const db = await getDatabase();
        const licenses = db.collection('licenses');
        const license = await licenses.findOne({ key: key.trim() });

        if (!license) {
            return res.status(404).json({ success: false, message: 'key_not_found' });
        }
        if (!license.isActive) {
            return res.status(403).json({ success: false, message: 'key_inactive' });
        }

        const updates = {};
        if (!license.hwid && hwid) {
            updates.hwid = hwid;
            license.hwid = hwid;
        } else if (license.hwid && license.hwid !== hwid) {
            return res.status(403).json({ success: false, message: 'hwid_mismatch' });
        }

        const now = new Date();
        let finalExpiry = license.expiresAt ? new Date(license.expiresAt) : null;

        if (license.type === 'timer') {
            if (!license.firstUsedAt) {
                const durationMinutes = Number(license.durationMinutes) || 1440;
                finalExpiry = new Date(now.getTime() + durationMinutes * 60000);
                updates.firstUsedAt = now;
                updates.expiresAt = finalExpiry;
                license.firstUsedAt = now;
                license.expiresAt = finalExpiry;
            } else {
                if (now.getTime() > finalExpiry.getTime()) {
                    return res.status(403).json({ success: false, message: 'key_expired' });
                }
            }
        } else if (finalExpiry) {
            if (now.getTime() > finalExpiry.getTime()) {
                return res.status(403).json({ success: false, message: 'key_expired' });
            }
        }

        if (Object.keys(updates).length > 0) {
            await licenses.updateOne({ _id: license._id }, { $set: updates });
        }

        try {
            await db.collection('logs').insertOne({
                licenseId: license._id,
                action: 'VALIDATE_SUCCESS',
                ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
                hwid: hwid || 'none',
                timestamp: now
            });
        } catch (logErr) {}

        return res.status(200).json({
            success: true,
            message: 'valid',
            owner: license.owner || 'Subscriber',
            expiresAt: finalExpiry ? finalExpiry.toISOString() : null,
            type: license.type || 'fixed'
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'server_error' });
    }
};
