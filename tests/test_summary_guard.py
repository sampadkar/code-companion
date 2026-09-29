from fastapi.testclient import TestClient

from api.index import app


def test_summary_without_uploaded_files_is_empty():
    client = TestClient(app)

    response = client.post(
        "/api/summary",
        json={
            "mode": "Bug hunt",
            "duration": "00:20",
            "transcript": [
                {"who": "You", "text": "I did not upload any file. Please do not invent an unused import issue."}
            ],
            "pins": [],
            "patches": [],
            "files": [],
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["findings"] == []
    assert body["unresolved"] == []
    assert body["next_steps"] == ["Upload the relevant source file or paste the code snippet to get a grounded review."]
