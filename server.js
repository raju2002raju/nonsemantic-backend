const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const poppler = require('pdf-poppler');
const Tesseract = require('tesseract.js');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const convertPdfToImages = async (pdfPath) => {
  const outputPath = path.join(__dirname, 'uploads', 'pdf-images');

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  const opts = {
    format: 'png',
    out_dir: outputPath.replace(/\\/g, '/'),
    out_prefix: path.basename(pdfPath, path.extname(pdfPath)),
    page: null,
  };

  try {
    await poppler.convert(pdfPath.replace(/\\/g, '/'), opts);
    return fs.readdirSync(outputPath).map((file) => path.join(outputPath, file));
  } catch (error) {
    console.error('Error converting PDF to images:', error.message);
    throw error;
  }
};

const performOcr = async (imagePath) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
      logger: info => console.log(info)

    });
    return text;
  } catch (error) {
    console.error('Error performing OCR:', error.message);
    throw error;
  }
};

const splitTextIntoParagraphs = (text) => {
  const paragraphs = text.split(/\r?\n\r?\n/).map(paragraph => paragraph.trim());
  return paragraphs;
};

app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = path.join(__dirname, req.file.path);

  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileSignature = fileBuffer.toString('utf8', 0, 4);

    if (fileSignature !== '%PDF') {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Invalid file format. Please upload a PDF file.' });
    }

    const imagePaths = await convertPdfToImages(filePath);
    const ocrResults = await Promise.all(imagePaths.map(async (imagePath) => {
      const text = await performOcr(imagePath);
      return text;
    }));

    const extractedText = ocrResults.join('\n\n');
    const paragraphs = splitTextIntoParagraphs(extractedText);

    res.json({ success: true, paragraphs });

  } catch (error) {
    console.error('Error processing PDF:', error.message);
    res.status(500).json({ error: `Failed to process PDF: ${error.message}` });
  } finally {
    fs.unlinkSync(filePath);
    fs.readdirSync(path.join(__dirname, 'uploads', 'pdf-images')).forEach(file => {
      fs.unlinkSync(path.join(__dirname, 'uploads', 'pdf-images', file));
    });
  }
});

async function getChatCompletion(query, paragraphs) {
  try {
    const prompt = `Act as a semantic search API. Given the following paragraphs:

${paragraphs.join('\n\n')}

Please answer the following question based on the content above: ${query}`;

    console.log(`Prompt: ${prompt}`);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error('Unexpected response structure from OpenAI API');
    }
  } catch (error) {
    console.error('Error during chat completion:', error.message);
    if (error.response) {
      console.error('OpenAI API response data:', error.response.data);
    }
    throw new Error('Chat completion failed');
  }
}

app.post('/search', async (req, res) => {
  try {
    const { query, paragraphs } = req.body;
    const answer = await getChatCompletion(query, paragraphs);
    res.json({ success: true, question: query, answer });
  } catch (error) {
    console.error('Error processing search:', error.message);
    res.status(500).json({ error: `Failed to process search: ${error.message}` });
  }
});

app.get('/', (req, res) => {
  res.send('OCR Server is running');
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});