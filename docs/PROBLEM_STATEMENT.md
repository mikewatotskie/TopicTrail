# TopicTrail: Problem Statement

**Team:** JAM · C-6 · Section C  
**Course:** ITMSD1, AY 2026–2027  
**SDG:** 4, Quality Education

## Background

Course syllabi describe learning outcomes, topics, and the intended coverage of a subject. However, a syllabus may only name a concept and not link directly to a beginner-friendly explanation or other freely accessible study material. A student who wants to review a topic can end up switching between a document reader, search engine, and several resource websites.

This is a **proposed design problem**, based on the project's initial concept. The frequency and severity of these difficulties among the intended student group have **not yet been established through documented user interviews or surveys**.

## Intended users and context

The initial audience is students who receive PDF or Word course syllabi and use a smartphone to organize independent study. The project is intended to be relevant to students in the Philippines, where avoiding additional subscription costs may be important. A specific campus or community sample should be documented if the team conducts field research.

## Working problem statement

Students who study from digital course syllabi may have difficulty quickly finding relevant, credible, and free explanations for unfamiliar syllabus topics because the document and learning-resource search process are disconnected.

## How Might We question

**How might we help students using digital course syllabi turn a selected topic into a short list of relevant, free learning resources without repeatedly switching between unrelated apps?**

## Proposed solution

**TopicTrail** is a proposed Android syllabus-reading app that integrates topic selection with resource discovery.

1. Students import a PDF or DOCX syllabus.
2. They open the syllabus and select a meaningful word, phrase, or passage.
3. They tap **Study** in the selection menu.
4. TopicTrail queries its supported educational resource providers.
5. It displays recommendations with titles, source details, and basic URL-screening feedback.
6. Students can open supported websites in-app or save useful resources for later.

The intended result is a more direct learning path from **a syllabus topic** to **a helpful learning resource**.

## SDG 4 alignment

TopicTrail aims to contribute to **SDG 4: Quality Education** by helping students discover freely accessible educational materials for self-directed learning. This is a proposed contribution, not a measured outcome. Future usability testing should evaluate discoverability, task success, perceived usefulness, and accessibility.

## Proposed value

- Reduce unnecessary steps between encountering a topic and finding study materials.
- Encourage students to use freely available resources.
- Keep recommended links organized by selected topic.
- Provide basic, accurately labeled URL and source screening.
- Support readable, accessible interfaces in Light and Dark Mode.

## Project boundaries and limitations

- The MVP targets Android with Flutter.
- PDF selection requires a text layer; scanned documents may need OCR later.
- DOCX formatting and selection depend on feasible free libraries.
- Searches may be limited to specific permissible educational providers; **not** all websites on the internet.
- Link screening cannot guarantee that a website is completely safe or accurate.
- Browser embedding depends on destination website policy and compatibility.
- The project aims to avoid mandatory paid runtime services; service quotas and connectivity remain constraints.
- The team has not yet documented measured student outcomes, interview quotations, or a completed field validation sample.

## Research and validation still needed

- Confirm the proposed pain points with actual students.
- Document participant recruitment, consent, and interview/testing dates.
- Compare the workflow against ordinary document-reader and web-search use.
- Test resource relevance, accessibility, and completion time once the MVP exists.
- Revise the problem statement when findings warrant it.

## Reference

TopicTrail's concept and approved product scope were supplied during project planning. The ITMSD1 official hackathon guide requires a localized **How Might We** problem statement and SDG alignment. This document uses no unverified statistics or fabricated user quotes.
