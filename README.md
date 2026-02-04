# debrid-canal

A Node.js web server that provides a simple interface for uploading torrent files or magnet links and retrieving unrestricted download links via RealDebrid's API.

## Overview

debrid-canal acts as a bridge between users and RealDebrid, allowing you to:
- Upload torrent files or magnet links through a web interface
- Automatically process them through your RealDebrid account
- Receive direct, unrestricted download links

## Features

- 🌐 Web-based interface for torrent/magnet link uploads
- 🔗 Integration with RealDebrid REST API
- 🐳 Docker support for easy deployment
- 🔐 Secure API key management via environment variables
- ⚡ Fast torrent processing and link generation

## Prerequisites

- Node.js (LTS version recommended)
- Docker (optional, for containerized deployment)
- RealDebrid account with an active API key

## Getting Your RealDebrid API Key

1. Log in to your [RealDebrid account](https://real-debrid.com/)
2. Navigate to your account settings
3. Find the API section to generate your API key
4. Copy the API key for use in the configuration

## Installation

### Local Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/debrid-canal.git
cd debrid-canal
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the project root:
```env
REALDEBRID_API_KEY=your_api_key_here
PORT=3000
```

4. Start the server:
```bash
npm start
```

### Docker Setup

1. Build the Docker image:
```bash
docker build -t debrid-canal .
```

2. Run the container:
```bash
docker run -d \
  -p 3000:3000 \
  -e REALDEBRID_API_KEY=your_api_key_here \
  --name debrid-canal \
  debrid-canal
```

Or using Docker Compose:
```bash
docker-compose up -d
```

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `REALDEBRID_API_KEY` | Your RealDebrid API key | Yes | - |
| `PORT` | Port for the web server | No | 3000 |
| `NODE_ENV` | Environment mode | No | production |

## Usage

1. Open your browser and navigate to `http://localhost:3000`
2. Upload a torrent file or paste a magnet link
3. Submit the form
4. Wait for processing
5. Receive your unrestricted download link

## RealDebrid API Endpoints

This project interacts with the following RealDebrid API endpoints:

- `POST /torrents/addTorrent` - Upload torrent file
- `POST /torrents/addMagnet` - Add magnet link
- `GET /torrents/info/{id}` - Get torrent information
- `POST /unrestrict/link` - Get unrestricted download link

For full API documentation, visit [RealDebrid API Docs](https://api.real-debrid.com/)

## Project Structure

```
debrid-canal/
├── src/
│   ├── server.js          # Main server file
│   ├── routes/            # API routes
│   ├── controllers/       # Request handlers
│   ├── services/          # RealDebrid API integration
│   └── public/            # Static files (HTML, CSS, JS)
├── Dockerfile             # Docker configuration
├── docker-compose.yml     # Docker Compose configuration
├── package.json           # Node.js dependencies
├── .env.example          # Example environment variables
├── .gitignore            # Git ignore rules
└── README.md             # This file
```

## Development

### Running in Development Mode

```bash
npm run dev
```

### Running Tests

```bash
npm test
```

## Security Notes

- Never commit your `.env` file or expose your RealDebrid API key
- The API key should always be stored as an environment variable
- Use HTTPS in production environments
- Consider implementing rate limiting to prevent API abuse

## Troubleshooting

### Common Issues

**Server won't start:**
- Ensure your RealDebrid API key is correctly set
- Check if the port is already in use
- Verify Node.js is installed correctly

**Torrent processing fails:**
- Verify your RealDebrid account has active premium status
- Check if the torrent/magnet link is valid
- Review RealDebrid API rate limits

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This tool is for personal use only. Please respect RealDebrid's terms of service and API usage limits. The developers are not responsible for any misuse of this software.

## Acknowledgments

- [RealDebrid](https://real-debrid.com/) for providing the API
- Node.js community for excellent tools and libraries
