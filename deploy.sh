#!/bin/bash

echo "🚀 Deploy triggered"

cd /home/xghrtkl/ai-system || exit

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
npm install

echo "🔁 Restarting server..."
pkill node
node server.js > app.log 2>&1 &

echo "✅ Deploy complete"
