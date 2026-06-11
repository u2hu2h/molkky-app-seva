import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
title: "Mölkky Score Tracker",
description: "モルック用リアルタイムスコア管理",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
return (
<html lang="ja">
<body>{children}</body>
</html>
);
}