# Geo-Tracker

A real-time location tracking and route management system built with React, Supabase, Google Maps, and Geolocation APIs.

## 🚀 Live Demo

[Open Geo-Tracker](https://abcvideo123.vercel.app)

## 📌 Overview

Geo-Tracker is a web-based real-time location tracking system designed to capture, manage, and visualize location data on an interactive map.

The project focuses on reliable GPS tracking, location updates, route visualization, location freshness, and filtering of inaccurate location data.

## ✨ Features

- 📍 Real-time location tracking
- 🗺️ Google Maps integration
- 🛣️ Route and travel path visualization
- 📡 Browser Geolocation API integration
- 🔄 Automatic location updates
- ⏱️ Last-seen and location freshness tracking
- 🎯 GPS accuracy filtering
- 🚗 Movement and speed-based filtering
- 📏 Distance calculation
- 🔴 Stale location detection
- 🔁 Location update retry and recovery
- ☁️ Supabase database integration
- 📱 Responsive web interface

## 🛠️ Tech Stack

### Frontend

- React
- JavaScript / TypeScript
- HTML5
- CSS

### Backend & Database

- Supabase
- REST APIs
- Real-time data synchronization

### APIs & Services

- Google Maps
- Browser Geolocation API
- Gemini API

### Deployment

- GitHub
- Vercel

## 🏗️ Project Structure

```text
Geo-Tracker/
├── api/
├── src/
│   ├── components/
│   ├── hooks/
│   ├── services/
│   └── utils/
├── public/
├── index.html
├── package.json
└── README.md
```

## 🔄 How It Works

1. The application requests the user's location through the Geolocation API.
2. Location updates are processed and validated before being stored.
3. GPS accuracy and movement-related conditions are used to reduce inaccurate location points.
4. Valid location data is synchronized with Supabase.
5. The latest location is retrieved for map visualization.
6. Route points are filtered and processed to provide a more reliable travel path.
7. Stale locations are detected using timestamp-based validation.

## 🗄️ Database

The project uses **Supabase** for storing and synchronizing location-related data.

The system works with location information such as:

- Current location
- Location updates
- Last-seen timestamps
- Route/location history
- Tracking-related data

## ⚙️ Run Locally

### Prerequisites

- Node.js
- npm
- Supabase project
- Required API keys

### Installation

Clone the repository:

```bash
git clone https://github.com/Ashish45188/Geo-Tracker.git
```

Navigate to the project directory:

```bash
cd Geo-Tracker
```

Install dependencies:

```bash
npm install
```

Create a `.env.local` file and add the required environment variables.

Then start the development server:

```bash
npm run dev
```

Open the local development URL shown in the terminal.

## 🔐 Environment Variables

Do not commit API keys or other secrets to GitHub.

Configure the required environment variables locally in `.env.local`.

Example:

```env
GEMINI_API_KEY=your_api_key
```

Add any other project-specific environment variables required by the application.

## 🔒 Security

- API keys and secrets should remain in environment variables.
- `.env.local` should be included in `.gitignore`.
- Never publish private credentials in the repository.
- Do not commit API keys, passwords, tokens, or other sensitive information.

## 📈 Future Improvements

- Improved background location tracking
- Enhanced route analytics
- More detailed tracking history
- Advanced location anomaly detection
- Improved performance for large-scale tracking
- Additional map-based analytics

## 👨‍💻 Author

**Ashish45188**

GitHub:

https://github.com/Ashish45188

## 📄 License

This project is currently available for portfolio and educational purposes.
