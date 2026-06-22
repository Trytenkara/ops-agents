"use client";

import { useEffect, useState } from "react";

// Time-of-day greeting computed in the viewer's local timezone. The pages are
// server-rendered in UTC, which made afternoons read as "Good evening"; doing it
// client-side after mount uses the operator's actual clock.
export function Greeting({ firstName }: { firstName?: string | null }) {
  const [greeting, setGreeting] = useState("Hello");
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);
  return (
    <>
      {greeting}
      {firstName ? `, ${firstName}` : ""}
    </>
  );
}
