import express from 'express';
import cors from 'cors';
import router from './routes/v1.js';
import { correlationMiddleware } from './middlewares/correlation.js';
import { errorHandler } from './middlewares/error.js';

const app = express();
app.use(cors());
app.use(correlationMiddleware);
app.use(express.json());
app.use('/api/v1', router);
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use(errorHandler);

export default app;
