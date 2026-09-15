"use client";
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  // Log the error for debugging
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">Something went wrong</h1>
          <p className="mb-6">We encountered an unexpected error. Please try refreshing the page.</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-ink text-white rounded-md hover:bg-ink/80"
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
