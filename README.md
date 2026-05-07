# debrid-canal
A Node.js web server that provides a simple interface for uploading torrent files or magnet links and retrieving download links via RealDebrid's API.

## Setup
### Requirements
- Node.js (LTS version recommended)
- RealDebrid account with an active [API key](https://real-debrid.com/apitoken) 
- Docker (optional, for containerized deployment)

### Node
```bash
git clone https://github.com/yourusername/debrid-canal.git
npm install
cp .env.example .env # add in your API key
npm start
```

### Docker Image
```bash
docker pull ghcr.io/<owner>/debrid-canal:latest
docker run -d \
  -p 3000:3000 \
  -e REALDEBRID_API_KEY=your_api_key_here \
  -e SESSION_SECRET=change_me \
  --name debrid-canal \
  ghcr.io/<owner>/debrid-canal:latest
```

### Environment Variables
| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `REALDEBRID_API_KEY` | Your RealDebrid API key | Yes | - |
| `PORT` | Port for the web server | No | 3000 |
| `NODE_ENV` | Environment mode | No | production |
| `LOG_LEVEL` | Logging level (trace, debug, info, warn, error, fatal) | No | info |

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer
This tool is for personal use only. Please respect RealDebrid's terms of service and API usage limits. The developers are not responsible for any misuse of this software.
