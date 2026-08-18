import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Use the dynamic port assigned by Render, or 3000 locally
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session cookies from your browser session logs
const cookies = {
    "uid": "8dbe2089-a17b-423d-b763-5f19e2703bd7",
    "si_usr_id": "54cbn9Zl_nJmeF",
    "si_ses_id": "54cbn9Zl_nJmeF"
};

const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');

// Maintain a persistent chat session ID for context memory
let currentChatId = "6b27fb1e-8dbf-4ba3-9a91-15870a8b7434"; 

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;

    const payload = {
        "user_input": userMessage,
        "model": "C",
        "persona": "normal",
        "mode": "usual",
        "max_turns": 6,
        "chat_id": currentChatId,
        "edit": false,
        "edit_mid": null,
        "regenerate": false,
        "attachments": []
    };

    try {
        const response = await axios.post(
            'https://notrack.ai/api/dispatch',
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://notrack.ai',
                    'Referer': 'https://notrack.ai/chat',
                    'Cookie': cookieString
                },
                responseType: 'stream'
            }
        );

        let fullReply = '';

        response.data.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data:')) {
                    const jsonStr = trimmed.replace('data:', '').trim();
                    if (jsonStr === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(jsonStr);
                        const token = parsed.content || parsed.message || parsed.delta || parsed.text || '';
                        fullReply += token;
                    } catch (e) {
                        // Ignore non-JSON lines
                    }
                }
            }
        });

        response.data.on('end', () => {
            res.json({ reply: fullReply || "Received empty stream from AI." });
        });

    } catch (error) {
        let errorBody = '';
        if (error.response && error.response.data) {
            error.response.data.on('data', (chunk) => {
                errorBody += chunk.toString();
            });
            error.response.data.on('end', () => {
                console.error('Server Rejection Details:', errorBody);
            });
        } else {
            console.error('API Communication Error:', error.message);
        }
        res.status(500).json({ reply: "Error communicating with the AI service." });
    }
});

app.listen(PORT, () => {
    console.log(`Chatbot server running on port ${PORT}`);
});
