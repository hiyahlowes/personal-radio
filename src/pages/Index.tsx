import { useSeoMeta } from '@unhead/react';
import { WelcomePage } from './WelcomePage';

const Index = () => {
  useSeoMeta({
    title: 'PR – Personal Radio',
    description: 'Your AI-powered personal radio station. Personalized music and podcasts, curated just for you.',
  });

  return <WelcomePage />;
};

export default Index;
