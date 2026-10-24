# TopicTrail

**An Interactive Syllabus Reader with Highlight-to-Study and Free Learning Resource Recommendations**

**Team JAM | Team C-6 | Section C | ITMSD1, AY 2026–2027**  
**UN Sustainable Development Goal 4: Quality Education**

> **Project status:** Design and planning stage. The Flutter mobile application and its core functions are planned, not yet claimed as implemented or tested.

## Overview

TopicTrail is a proposed Android learning app that helps students connect topics found in their course syllabi to relevant, free educational resources. Instead of switching repeatedly between a syllabus document and a web search, a student can select text in an imported document and choose **Study** to request topic-based learning recommendations.

The project supports **SDG 4: Quality Education** by exploring a practical way to improve access to organized learning resources. Its benefits will need to be evaluated with student feedback and a functioning prototype.

## Problem and proposed solution

A course syllabus outlines what students need to learn, but it does not necessarily provide a direct pathway to understandable materials for every topic. TopicTrail proposes a more connected workflow: **import a syllabus → select a topic → tap Study → review resources → open or save useful links**.

Read the [problem statement](docs/PROBLEM_STATEMENT.md) for the project scope, assumptions, and intended beneficiaries.

## Proposed core features

| Feature | Intended behavior | Status |
| --- | --- | --- |
| PDF and DOCX syllabus import | Choose and keep readable syllabus files locally | Planned |
| Interactive syllabus reader | Read text-based documents and select words or passages | Planned |
| Highlight-to-Study | Show **Copy**, **Select All**, and **Study** for selected text | Planned |
| Free resource recommendations | Search supported, permitted educational sources using a selected topic | Planned |
| Link Shield | Perform basic URL checks and transparent source screening; **not** a guarantee of safety | Planned |
| In-app resource viewer | Open supported learning websites inside the app | Planned |
| Saved resources | Bookmark links for future access | Planned |
| Themes | Light, Dark, and system preference | Planned |

**Scope note:** Scanned-document OCR, unrestricted web-wide search, advanced AI recommendations, and a network honeypot are not part of the initial minimum viable product. DOCX formatting and selectable PDF support depend on validated technical choices.

## Target users

Students who rely on course syllabi when planning and organizing their study sessions, especially those who prefer accessible, no-cost learning resources. The [personas](USER_PERSONAS.md) are **provisional design hypotheses**, not results of completed interviews.

## Planned technology

- **Design:** Figma / FigJam
- **Mobile application:** Flutter (Dart), primarily Android
- **Development environment:** VS Code and OpenCode
- **Storage:** Local-first approach; package/database decisions pending
- **Learning resources:** Permitted free APIs or curated open educational sources, subject to availability and terms
- **Cost target:** No mandatory paid service; free-service quotas and limitations must be documented

## Figma design

[View the TopicTrail Figma project](https://www.figma.com/design/K7G68R3vNSWiNuRF1I3o0o/TopicTrail-%C2%B7-Team-JAM--C-6--%C2%B7-Mobile-UI---Prototype?node-id=2-5)

Approved design colors: primary blue `#003399`, sky blue `#60B5FF`, yellow accent `#FFCC00`, light background `#F7F9FC`, and dark background `#0B1220`. Final visuals and prototype behavior are governed by the Figma file.

## Project documents

- [Problem Statement](docs/PROBLEM_STATEMENT.md)
- [User Personas](USER_PERSONAS.md)
- [User Flow](USER_FLOW.md)
- [Week 1 Validation and Evidence Checklist](WEEK1_VALIDATION.md)
- [AI Disclosure Log](AI_DISCLOSURE_LOG.md)

## ITMSD1 milestone roadmap

| Milestone | Expected work | Evidence status |
| --- | --- | --- |
| Week 1 | Problem discovery, personas, mobile IA/user flow, low-fidelity wireframes | Documentation drafted; team evidence/validation pending |
| Week 2 | Figma design system, accessible hi-fi screens, interactive prototype, peer test | Figma supplied; formal checklist verification pending |
| Week 3 | Flutter MVP, navigation, 3+ core screens, local state/persistence, disclosure updates | Pending |
| Week 4 | Cross-device test, video demonstration, pitch, defense, final build | Pending |

## Development and contribution policy

The repository will be updated with Flutter source code after the development environment and design handoff are verified. The team will keep source changes reviewable and document significant AI-assisted design or code work in [`AI_DISCLOSURE_LOG.md`](AI_DISCLOSURE_LOG.md).

## Team

**Team JAM · C-6 · Section C**. Individual member names, assigned roles, and contributions will be added after the team confirms them.

---

*This repository currently communicates the intended solution and preparation work. It does not claim a working mobile application.*
