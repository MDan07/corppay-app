# CorpPay — Cafe Employee & Payroll Management System

## Overview

CorpPay is a web-based application developed to support employee management and payroll operations in cafe businesses. It brings employee records, work schedules, salary calculations, and payment history together in one interface.

The project focuses on simplifying routine management tasks and providing a structured way to record and review employee payments.

## Features

- **Employee Management:** Add and manage employee records, assign roles, and associate employees with cafe locations.
- **Cafe Management:** Organize cafe locations and manage their associated employees.
- **Role Management:** Create and update employee roles with default salary settings.
- **Work Scheduling:** Configure weekly schedules and shift assignments for employees.
- **Payroll Calculation:** Calculate salary amounts using the configured base salary, recorded shifts, bonuses, deductions, and advances.
- **Payment Tracking:** Record employee payments and review payment information by month.
- **Payslip Generation:** Generate detailed payslip reports containing employee information, payment summaries, and financial records.
- **Dashboard Interface:** Navigate between management sections through an interactive interface.
- **Theme Support:** Switch between light and dark themes.

## Technology Stack

| Technology | Purpose |
|---|---|
| React | Building the user interface and managing application state |
| Vite | Development server and production build tooling |
| JavaScript | Application logic and payroll calculations |
| Firebase Authentication | User authentication |
| Cloud Firestore | Storing and retrieving application records |
| React Three Fiber | Rendering interactive 3D background effects |
| CSS | Styling and responsive interface components |

## Application Structure

The application is organized around a React frontend connected to Firebase services.

- **User interface:** React components handle navigation, forms, dashboards, and management views.
- **Authentication:** Firebase Authentication manages user sign-in and sign-out.
- **Data storage:** Cloud Firestore stores records for cafes, employees, roles, logs, and payments.
- **Payroll logic:** Application functions calculate salary breakdowns and prepare payment reports.
- **Presentation:** CSS styles the interface, while React Three Fiber provides visual background effects.

## Getting Started

### Prerequisites

- Node.js
- npm
- A Firebase project with Authentication and Cloud Firestore configured

### Installation

Clone the repository:

```bash
git clone https://github.com/MDan07/corppay-app.git
cd corppay-app
```

Install the project dependencies:

```bash
npm install
```

### Firebase Configuration

Create a `.env.local` file in the project root and configure the following environment variables:

```env
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_storage_bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

Replace the example values with the configuration for your Firebase project. Enable the required authentication provider and configure Cloud Firestore before running the application.

### Run the Development Server

```bash
npm run dev
```

Vite will display the local development URL in the terminal.

### Build for Production

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

## Data and Security

The application uses Firebase Authentication and Cloud Firestore. Appropriate Firestore Security Rules should be configured and tested to restrict access to authorized users and protect employee and payroll information.

The Firebase web configuration is supplied through Vite environment variables. These variables are included in the client-side application when built and should not be treated as private secrets.

Real employee information and payroll records should not be included in public demonstrations or repository files.

## Project Status

CorpPay is an ongoing project. Its functionality and implementation may evolve as the application is developed and tested.

## License

No license has been specified for this repository.
