# Collaborative-canvas
# Real-Time Collaborative Drawing Canvas

A multi-user **real-time dra** app built using **Vanilla JavaScript**, **HTML5 Canvas**, and **Node.js (Socket.IO)** — where multiple users can draw simultaneously on the same canvas, see each other's cursors, and collaborate in real time.

---

## Features

- **Drawing Tools** — Brush, Eraser, adjustable stroke width & color  
- **Real-Time Sync** — Instantly see other users' drawings as they draw  
- **User Indicators** — Live cursors with user colors  
- **Global Undo/Redo** — Works across all users (per-stroke)  
- **Mobile Touch Support** — Draw seamlessly on touch devices  


---

## Technical Stack

| Layer | Technology | Description |
|--------|-------------|-------------|
| **Frontend** | Vanilla JS, HTML5 Canvas, CSS | Raw DOM manipulation and custom canvas rendering (no frameworks or libraries) |
| **Backend** | Node.js, Express.js, Socket.IO | Real-time WebSocket server |
| **Protocol** | WebSocket (Socket.IO) | Bidirectional low-latency communication |
| **State Management** | Operation log + group-based undo/redo | Deterministic replay of strokes |
| **Deployment** | Render (Web Service) | Free-tier Node.js hosting with WebSocket support |

**Constraints:**
- No frontend frameworks (React/Vue)
- No external drawing libraries
- Only pure Canvas API and DOM


