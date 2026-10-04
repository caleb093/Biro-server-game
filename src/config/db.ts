import mongoose from "mongoose";
import { env } from "./env";

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(env.mongoUri);
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    } catch (error: any) {
        console.error(`❌ MongoDB connection failed: ${error.message}`);
        process.exit(1);
    }
};

export default connectDB;
