require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
  res.send("JebatClaw API is running 🚀");
});

app.get("/properties", async (req, res) => {
  const { data, error } = await supabase.from("properties").select("*");
  if (error) return res.status(500).json(error);
  res.json(data);
});

app.post("/upload", upload.single("image"), async (req, res) => {
  const file = req.file;
  const fileName = `${Date.now()}-${file.originalname}`;

  const { error } = await supabase.storage
    .from("property-images")
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
    });

  if (error) return res.status(500).json(error);

  const { data } = supabase.storage
    .from("property-images")
    .getPublicUrl(fileName);

  res.json({ url: data.publicUrl });
});

app.post("/properties", async (req, res) => {
  const { title, price, location, image_url } = req.body;

  const { data, error } = await supabase
    .from("properties")
    .insert([{ title, price, location, image_url }]);

  if (error) return res.status(500).json(error);
  res.json(data);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running 🚀"));
