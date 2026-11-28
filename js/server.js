const outBuf = await composeCollage(sess.shots, filterId, frameUrl);
    if (sess.shots.length >= slotCount) {
      sessions.delete(key);
    }

    const fileId = crypto.randomUUID();
    const fileName = `${fileId}.jpg`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), outBuf);

    const outputUrl = `${getBaseUrl(req)}/out/${fileName}`;
    return res.status(200).json({
      result: {
        data: {
          output_url: outputUrl
        }
      }
    });
  } catch (err) {
    return res.status(502).json({
      error: {
        status: "FILTER_BACKEND_ERROR",
        message: err && err.message ? err.message : "PROCESS_FAILED"
      }
    });
  }
});

app.post("/generateCaption", async (req, res) => {
  const data = (req.body && req.body.data) || {};
  const fallbackCaption = typeof data.prompt === "string" && data.prompt.trim()
    ? data.prompt.trim()
    : "Chụp một tấm thật chill ✨";

  return res.status(200).json({
    result: {
      caption: fallbackCaption
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Locket PhotoBooth Worker running on port", port);
});
