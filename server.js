const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws'); // 👈 Add WebSocket library

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Setup WebSocket Server
const server = app.listen(PORT, () => {
    console.log(`🚀 Video Downloader API running on port ${PORT}`);
    console.log(`📱 Frontend available at http://localhost:${PORT}`);
});
const wss = new WebSocket.Server({ server });

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const ensureDownloadsDir = async () => {
    try {
        await fs.access(DOWNLOADS_DIR);
    } catch {
        await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
    }
};

// Utility function to run yt-dlp commands with progress reporting
const runYtDlp = (args, onProgress) => {
    return new Promise((resolve, reject) => {
        const process = spawn('yt-dlp', args);
        let output = '';
        let error = '';

        process.stdout.on('data', (data) => {
            const outputString = data.toString();
            output += outputString;
            
            // Check for progress indicator from yt-dlp and report it
            const match = outputString.match(/\[download\]\s+(\d+\.\d+)% of/);
            if (match && match[1]) {
                const percent = parseFloat(match[1]);
                onProgress({ type: 'progress', percent });
            }
        });

        process.stderr.on('data', (data) => {
            const errorString = data.toString();
            error += errorString;
            // Report specific errors as they happen
            if (errorString.includes('ERROR:')) {
                onProgress({ type: 'error', message: errorString });
            }
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(error || 'Video processing command failed'));
            }
        });
    });
};

// Utility function to run FFmpeg commands
const runFFmpeg = (args, onProgress) => {
    return new Promise((resolve, reject) => {
        const process = spawn('ffmpeg', args);
        let error = '';

        process.stderr.on('data', (data) => {
            const errorString = data.toString();
            error += errorString;
            // FFmpeg doesn't have a simple progress format, so we'll just send a fixed progress update
            if (errorString.includes('size=')) {
                onProgress({ type: 'progress', percent: 90 });
            }
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(error || 'Video conversion failed'));
            }
        });
    });
};

// Get video information (this route remains the same)
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        const args = ['--dump-json', '--no-download', url];
        const output = await runYtDlp(args, () => {}); // No progress needed here
        const videoInfo = JSON.parse(output);
        res.json({
            title: videoInfo.title,
            duration: videoInfo.duration_string || 'Unknown',
            uploader: videoInfo.uploader || 'Unknown',
            thumbnail: videoInfo.thumbnail,
            formats: videoInfo.formats?.map(f => ({
                format_id: f.format_id,
                ext: f.ext,
                quality: f.height || 0,
                filesize: f.filesize
            })) || []
        });
    } catch (error) {
        console.error('Error getting video info:', error);
        res.status(500).json({ 
            error: 'Failed to get video information. Please check the URL and try again.' 
        });
    }
});

// WebSocket connection handler
wss.on('connection', ws => {
    ws.on('message', async message => {
        try {
            const { type, payload } = JSON.parse(message);
            if (type === 'download-request') {
                const { url, format, quality } = payload;
                
                // Helper function to send progress updates to the client
                const sendProgress = (update) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(update));
                    }
                };
                
                sendProgress({ type: 'status', message: 'Fetching video information...', percent: 5 });
                
                // Use a try-catch block to handle errors during the download process
                try {
                    await ensureDownloadsDir();

                    const infoArgs = ['--get-title', url];
                    const videoTitle = (await runYtDlp(infoArgs, sendProgress)).trim();
                    const sanitizedTitle = videoTitle.replace(/[\\/:*?"<>|]/g, '').trim() || 'video';
                    
                    sendProgress({ type: 'status', message: `Processing: ${videoTitle}`, percent: 10 });

                    const fileId = uuidv4();
                    const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
                    const finalFilename = `${sanitizedTitle}.${format}`;
                    let outputTemplate, finalPath;

                    // Handle download based on determined format
                    if (['mp3', 'm4a'].includes(format)) {
                        outputTemplate = path.join(DOWNLOADS_DIR, `${fileId}_${sanitizedUrl}.%(ext)s`);
                        const ytDlpArgs = [
                            '--extract-audio',
                            '--audio-format', format,
                            '--audio-quality', '0',
                            '--output', outputTemplate,
                            '--no-playlist',
                            '--embed-thumbnail',
                            url
                        ];
                        
                        sendProgress({ type: 'status', message: 'Downloading audio...', percent: 20 });
                        await runYtDlp(ytDlpArgs, sendProgress);
                        finalPath = path.join(DOWNLOADS_DIR, `${fileId}_${sanitizedUrl}.${format}`);
                        
                    } else if (['mp4', 'webm'].includes(format)) {
                        outputTemplate = path.join(DOWNLOADS_DIR, `${fileId}_${sanitizedUrl}.%(ext)s`);
                        let formatSelector;
                        if (quality === 'auto') {
                            formatSelector = `bestvideo[ext=${format}]+bestaudio/best`;
                        } else {
                            const height = quality.replace('p', '');
                            formatSelector = `bestvideo[height<=${height}][ext=${format}]+bestaudio[ext=m4a]/best[height<=${height}][ext=${format}]`;
                        }
                        const ytDlpArgs = [
                            '--format', formatSelector,
                            '--output', outputTemplate,
                            '--no-playlist',
                            '--merge-output-format', format,
                            '--embed-subs',
                            '--write-auto-subs',
                            '--sub-lang', 'en',
                            url
                        ];

                        sendProgress({ type: 'status', message: 'Downloading video...', percent: 20 });
                        await runYtDlp(ytDlpArgs, sendProgress);

                        const files = await fs.readdir(DOWNLOADS_DIR);
                        const downloadedFile = files.find(f => f.startsWith(`${fileId}_${sanitizedUrl}`));
                        if (!downloadedFile) {
                            throw new Error('Downloaded file not found');
                        }
                        finalPath = path.join(DOWNLOADS_DIR, downloadedFile);

                        // Check if conversion is needed (e.g., merging audio/video streams)
                        if (!downloadedFile.endsWith(`.${format}`)) {
                             const convertedPath = path.join(DOWNLOADS_DIR, `${fileId}_${sanitizedUrl}_converted.${format}`);
                             sendProgress({ type: 'status', message: 'Converting file...', percent: 80 });
                             await runFFmpeg(['-i', finalPath, '-c', 'copy', convertedPath], sendProgress);
                             await fs.unlink(finalPath);
                             finalPath = convertedPath;
                        }
                    } else {
                         throw new Error(`Unsupported format: ${format}`);
                    }
                    
                    const stats = await fs.stat(finalPath);
                    if (stats.size === 0) {
                        throw new Error('Downloaded file is empty');
                    }

                    // Send the download link back to the client
                    sendProgress({ 
                        type: 'download-ready', 
                        filename: finalFilename, 
                        size: stats.size,
                        url: `/download/${path.basename(finalPath)}`
                    });

                } catch (error) {
                    let errorMessage = 'Failed to download video. Please check the URL and try again.';
                    if (error.message.includes('format is not available')) {
                        errorMessage = 'Video format not available. Try a different quality setting.';
                    } else if (error.message.includes('private') || error.message.includes('login')) {
                        errorMessage = 'Video is private or requires login. Please check if the video is publicly accessible.';
                    } else if (error.message.includes('geo')) {
                        errorMessage = 'Video not available in your region due to geographic restrictions.';
                    } else if (error.message.includes('copyright')) {
                        errorMessage = 'Video unavailable due to copyright restrictions.';
                    }
                    sendProgress({ type: 'error', message: errorMessage });
                }
            }
        } catch (err) {
            console.error('Error processing WebSocket message:', err);
            if (ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'error', message: 'An internal server error occurred.' }));
            }
        }
    });
});

// New route to serve the temporary downloaded files
app.get('/download/:filename', async (req, res) => {
    const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
    try {
        await fs.access(filePath);
        res.download(filePath, req.params.filename, async (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'File download failed' });
                }
            } else {
                // Clean up file after download
                try {
                    await fs.unlink(filePath);
                    console.log(`Cleaned up file: ${filePath}`);
                } catch (cleanupErr) {
                    console.error('Error cleaning up file:', cleanupErr);
                }
            }
        });
    } catch (err) {
        console.error('File not found:', err);
        res.status(404).json({ error: 'File not found or has expired.' });
    }
});

module.exports = app;