import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// Helper functions
const readJSON = (file) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  return JSON.parse(fs.readFileSync(file));
};
const writeJSON = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Admin credentials
const ADMIN = { email: "00adarsh.kudachi00@gmail.com", password: "123" };

// SSE clients
let clients = [];
function broadcastOrders() {
  const orders = readJSON("orders.json");
  clients.forEach((c) =>
    c.write(`data: ${JSON.stringify({ orders, shopStatus })}\n\n`)
  );
}

// Shop status
let shopStatus = { isOpen: false, acceptingOrders: true };

// Routes
app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/dashboard.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);

// Login
app.post("/login", (req, res) => {
  const { email, password, role } = req.body;

  if (role === "admin") {
    if (email === ADMIN.email && password === ADMIN.password)
      return res.json({
        msg: "Admin login success",
        role: "admin",
        redirect: "/dashboard.html",
      });
    return res.status(400).json({ msg: "Invalid admin credentials" });
  }

  const users = readJSON("users.json");
  const user = users.find(
    (u) => u.email === email && u.password === password && u.role === "student"
  );
  if (!user) return res.status(400).json({ msg: "Invalid student credentials" });

  res.json({
    msg: "Student login success",
    role: "student",
    redirect: "/home.html",
    email: user.email,
    name: user.name,
  });
});

// Signup
app.post("/signup", (req, res) => {
  const { email, password, name } = req.body;
  const users = readJSON("users.json");
  if (users.find((u) => u.email === email))
    return res.status(400).json({ msg: "Email exists" });

  users.push({ email, password, name, role: "student" });
  writeJSON("users.json", users);
  res.json({ msg: "Signup success", email, name });
});

// OTP send
app.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);

  let otps = readJSON("otps.json");
  otps = otps.filter((o) => o.email !== email);
  otps.push({ email, otp, createdAt: Date.now() });
  writeJSON("otps.json", otps);

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to: email,
      subject: "Canteen System OTP",
      text: `Your OTP is: ${otp}`,
    });

    res.json({ msg: "OTP sent" });
  } catch (e) {
    console.log(e);
    res.status(500).json({ msg: "Error sending OTP" });
  }
});

// OTP verify
app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  let otps = readJSON("otps.json");
  const record = otps.find((o) => o.email === email && o.otp == otp);
  if (!record) return res.status(400).json({ msg: "Invalid OTP" });
  res.json({ msg: "OTP verified" });
});

// Menu
app.get("/menu", (req, res) => res.json(readJSON("menu.json")));
app.post("/menu/add", (req, res) => {
  const { name, price } = req.body;
  if (!name || !price) return res.status(400).json({ msg: "Enter name & price" });

  const menu = readJSON("menu.json");
  menu.push({ id: Date.now(), name, price });
  writeJSON("menu.json", menu);
  res.json({ msg: "Item added" });
});
app.post("/menu/remove", (req, res) => {
  const { id } = req.body;
  let menu = readJSON("menu.json");
  menu = menu.filter((item) => item.id != id);
  writeJSON("menu.json", menu);
  res.json({ msg: "Item removed" });
});

// Orders
// Order Initiate (generate QR but don't save yet)
app.post("/order/initiate", async (req, res) => {
  const { email, items } = req.body;

  if (!shopStatus.isOpen) return res.status(400).json({ msg: "Shop is closed" });
  if (!shopStatus.acceptingOrders)
    return res.status(400).json({ msg: "Not accepting orders right now" });
  if (!email || !items?.length) return res.status(400).json({ msg: "Invalid order" });

  const totalAmount = items.reduce((sum, i) => sum + Number(i.price), 0);
  const tempOrder = {
    id: Date.now(),
    email,
    items,
    totalAmount,
  };

  try {
    const upiID = "7829606988-2@ybl"; // replace with your UPI ID
    const upiLink = `upi://pay?pa=${upiID}&pn=KLE%20CET%20Canteen&am=${totalAmount}&cu=INR&tn=Order%20${tempOrder.id}`;
    const qrCode = await QRCode.toDataURL(upiLink);

    // only send QR and order data, don't save yet
    res.json({
      msg: "Proceed to pay",
      qrCode,
      upiLink,
      order: tempOrder,
    });
  } catch (err) {
    console.error("QR generation failed:", err);
    res.status(500).json({ msg: "Failed to generate QR" });
  }
});

// Confirm payment (store order permanently)
app.post("/order/confirm", (req, res) => {
  const { orderId, email, items, totalAmount } = req.body;

  const orders = readJSON("orders.json");
  const orderExists = orders.find((o) => o.id == orderId);
  if (orderExists)
    return res.status(400).json({ msg: "Order already confirmed" });

  const newOrder = {
    id: orderId,
    email,
    items,
    totalAmount,
    status: "Paid",
    createdAt: new Date().toISOString(),
  };

  orders.push(newOrder);
  writeJSON("orders.json", orders);
  broadcastOrders();

  res.json({ msg: "Payment confirmed, order sent to admin", redirect: "/home.html" });
});


// Student orders
app.get("/student/orders", (req, res) => {
  const email = req.query.email;
  const orders = readJSON("orders.json").filter((o) => o.email === email);
  res.json(orders);
});

// Admin orders
app.get("/admin/orders", (req, res) => res.json(readJSON("orders.json")));
app.post("/admin/order/update", (req, res) => {
  const { orderId, status } = req.body;
  const orders = readJSON("orders.json");
  const order = orders.find((o) => o.id == orderId);
  if (!order) return res.status(404).json({ msg: "Order not found" });

  order.status = status;
  writeJSON("orders.json", orders);
  broadcastOrders();
  res.json({ msg: "Order updated" });
});

// Users
app.get("/users.json", (req, res) => res.json(readJSON("users.json")));

// SSE for live updates
app.get("/admin/orders/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
  res.write(`data: ${JSON.stringify({ orders: readJSON("orders.json"), shopStatus })}\n\n`);
});

// Shop status toggle
app.get("/shop/status", (req, res) => res.json(shopStatus));
app.post("/shop/toggle", (req, res) => {
  const { action } = req.body;

  if (action === "open") shopStatus = { isOpen: true, acceptingOrders: true };
  else if (action === "close") {
    shopStatus = { isOpen: false, acceptingOrders: false };
    writeJSON("orders.json", []);
    broadcastOrders();
  } else if (action === "pause" && shopStatus.isOpen) shopStatus.acceptingOrders = false;
  else if (action === "resume" && shopStatus.isOpen) shopStatus.acceptingOrders = true;

  broadcastOrders();
  res.json({ msg: "Shop status updated", shopStatus });
});

// Start server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
