const express = require('express');
const router = express.Router();
const { AccessToken } = require('livekit-server-sdk');

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;

router.get('/token', async (req, res) => {
    const { room, username } = req.query;
    const userId = req.session.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!room || !username) {
        return res.status(400).json({ error: 'Missing room or username' });
    }

    if (!apiKey || !apiSecret) {
        return res.status(500).json({ error: 'LiveKit credentials not configured on server' });
    }

    try {
        const at = new AccessToken(apiKey, apiSecret, {
            identity: userId,
            name: username,
        });

        at.addGrant({
            roomJoin: true,
            room: room,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });

        res.json({
            token: await at.toJwt(),
            url: livekitUrl
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
