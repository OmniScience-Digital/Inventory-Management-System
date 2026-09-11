import 'dotenv/config';
import express from 'express';
const router = express.Router();
router.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: `Environment: ${process.env.NODE_ENV} API reachable`,
        uptime_seconds: process.uptime(),
        memory_usage: process.memoryUsage(),
        node_version: process.version,
        timestamp: new Date(),
    });
});
export default router;
